/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse");
const knex = require("knex");
require("dotenv").config();

const db = knex({
  client: "pg",
  connection: process.env.DATABASE_URL,
  pool: { min: 1, max: 10 },
});

// --------------------- header aliases tuned to your file ---------------------

const H = {
  reporterIso3: ["ReporterISO3"],
  reporterName: ["ReporterName"],
  partnerIso3:  ["PartnerISO3"],
  partnerName:  ["PartnerName"],
  year:         ["Year"],
  flowName:     ["TradeFlowName"],
  flowCode:     ["TradeFlowCode"],

  productCode:  ["ProductCode"],
  productName:  ["Product Name", "ProductName", "Commodity", "Commodity Name"],

  valueKUsd:    ["TradeValue in 1000 USD", "Trade Value in 1000 USD"],
  valueUsd:     ["Trade Value (US$)", "TradeValue (US$)", "Trade Value in USD", "TradeValue"],

  netWeightKg:  ["NetWeight in KGM", "Net weight (kg)", "Netweight (kg)", "NetWeight (kg)"],
  quantity:     ["Quantity"],
  qtyUnit:      ["QtyUnit", "Unit", "Quantity Unit"],

  period:       ["Period"],
  dataJobId:    ["DataJobID", "JobID"],
};

// Only keep these
const GROSS_FLOW_CODES = new Set([1, 2]); // 1=Gross Imp., 2=Gross Exp.

// --------------------- helpers ---------------------

function pick(row, keys) {
  for (const k of keys) {
    if (k in row && row[k] !== undefined && row[k] !== null && String(row[k]).trim() !== "") {
      return row[k];
    }
  }
  return undefined;
}

function toNumber(x) {
  if (x === undefined || x === null || x === "") return null;
  const n = Number(String(x).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function toMonthStart(year, period) {
  if (period) {
    const s = String(period).trim();
    if (/^\d{6}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-01`;
    if (/^\d{4}-\d{2}$/.test(s)) return `${s}-01`;
  }
  const y = Number(year);
  if (!Number.isFinite(y)) throw new Error(`Invalid Year: ${year}`);
  return `${y}-01-01`;
}

function normalizeDirection(flowName) {
  const s = String(flowName || "").toLowerCase();
  if (s.includes("gross imp") || s.includes("import")) return "import";
  if (s.includes("gross exp") || s.includes("export")) return "export";
  if (s.includes("re-export") || s.includes("reexport")) return "export";
  throw new Error(`Unknown Trade Flow: ${flowName}`);
}

async function ensureTradePartner({ iso3, name }) {
  const iso = iso3 ? String(iso3).toUpperCase().slice(0, 3) : null;
  if (iso) {
    const byIso = await db("core.trade_partners").select("id").where({ iso3: iso }).first();
    if (byIso) return byIso.id;
  }
  if (name) {
    const byName = await db("core.trade_partners").select("id").where({ name }).first();
    if (byName) return byName.id;
  }
  const [row] = await db("core.trade_partners")
    .insert({ iso3: iso || null, name: name || iso || null, region: null })
    .returning(["id"]);
  return row.id;
}

async function ensureCommodity({ code, name, classification = "SITC" }) {
  if (!code) throw new Error("Missing Product Code");
  const existing = await db("core.commodities").select("id", "classification").where({ code }).first();
  if (existing) {
    if (!existing.classification && classification) {
      await db("core.commodities").where({ id: existing.id }).update({ classification });
    }
    return existing.id;
  }
  const [row] = await db("core.commodities")
    .insert({
      code: String(code),
      name: name || String(code),
      category: "agriculture",
      unit: null,
      classification
    })
    .returning(["id"]);
  return row.id;
}

// upsert with unique tuple
async function upsertTradeData(unique, payload) {
  const updated = await db("core.trade_data").where(unique).update(payload);
  if (updated === 0) {
    await db("core.trade_data").insert({ ...unique, ...payload });
    return "inserted";
  }
  return "updated";
}

// --------------------- loader ---------------------

async function loadCsv(filePath, opts = {}) {
  const classification = opts.classification || "SITC";
  const source = opts.source || "WITS";

  console.log("📥 Loading:", filePath);
  const parser = fs.createReadStream(filePath).pipe(parse({ columns: true, bom: true, skip_empty_lines: true }));

  let total = 0, written = 0, skipped = 0, skippedNonGross = 0;

  for await (const r of parser) {
    total++;

    try {
      const reporterIso3 = pick(r, H.reporterIso3);
      const reporterName = pick(r, H.reporterName);
      const partnerIso3  = pick(r, H.partnerIso3);
      const partnerName  = pick(r, H.partnerName);
      const year         = pick(r, H.year);
      const flowName     = pick(r, H.flowName);
      const flowCodeRaw  = pick(r, H.flowCode);

      const productCode  = String(pick(r, H.productCode) || "").trim();
      const productName  = pick(r, H.productName);

      if (!productCode || /^total$/i.test(productCode)) { skipped++; continue; }

      const tradeFlowCode = toNumber(flowCodeRaw);

      // ⭐ Only keep Gross Import/Export
      if (!GROSS_FLOW_CODES.has(tradeFlowCode)) { skippedNonGross++; continue; }

      const reporterId = await ensureTradePartner({ iso3: reporterIso3, name: reporterName });
      const partnerId  = await ensureTradePartner({ iso3: partnerIso3,  name: partnerName  });
      const commodityId = await ensureCommodity({ code: productCode, name: productName, classification });

      const direction = normalizeDirection(flowName);

      const period = pick(r, H.period);
      const period_month = toMonthStart(year, period);
      const period_year = Number(year);

      // VALUE: "TradeValue in 1000 USD"
      let value_usd = null;
      const vKUsd = pick(r, H.valueKUsd);
      if (vKUsd !== undefined) {
        const vk = toNumber(vKUsd);
        value_usd = vk != null ? vk * 1000 : null;
      } else {
        const vUsd = pick(r, H.valueUsd);
        if (vUsd !== undefined) value_usd = toNumber(vUsd);
      }
      if (value_usd == null) { skipped++; continue; }

      // QUANTITY + UNIT
      const netW = pick(r, H.netWeightKg);
      const qty  = pick(r, H.quantity);
      const quantity = toNumber(netW !== undefined ? netW : qty);
      const quantity_unit = (pick(r, H.qtyUnit) || (netW !== undefined ? "kg" : null)) || null;

      const source_job_id = pick(r, H.dataJobId) || null;
      const source_file = path.basename(filePath);

      // include trade_flow_code in unique key (even though we only keep 1/2)
      const unique = {
        commodity_id: commodityId,
        direction,
        trade_flow_code: tradeFlowCode,
        period_month,
        partner_id: partnerId,
        revision: 1,
      };

      const payload = {
        value_usd,
        quantity,
        unit: quantity_unit,
        quantity_unit,
        reporter_id: reporterId,
        period_year,
        source,
        source_job_id,
        source_file,
        loaded_at: db.fn.now(),
      };

      await upsertTradeData(unique, payload);
      written++;
      if (written % 1000 === 0) process.stdout.write(`   …${written} / ${total}\r`);
    } catch (err) {
      skipped++;
      console.warn(`⚠️  Skipped row ${total}: ${err.message}`);
    }
  }

  console.log(`\n✅ Done. rows=${total}, written=${written}, skipped=${skipped}, skipped_non_gross=${skippedNonGross}`);
}

// --------------------- CLI ---------------------

(async () => {
  try {
    const fileArg = process.argv[2] || path.join(process.cwd(), "data", "wits", "DataJobID-2973967_Capstone.csv");
    const classification = (process.argv[3] || "SITC").toUpperCase();

    if (!fs.existsSync(fileArg)) {
      console.error(`❌ File not found: ${fileArg}`);
      process.exit(1);
    }

    await loadCsv(fileArg, { classification, source: "WITS" });
  } catch (e) {
    console.error(e);
  } finally {
    await db.destroy();
  }
})();
