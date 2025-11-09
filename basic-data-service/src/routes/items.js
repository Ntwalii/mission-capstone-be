const { Router } = require('express');
const { z } = require('zod');
const db = require('../services/db');
// If you still want endpoints to be private, keep requireAuth; otherwise remove it
const { requireAuth } = require('../middleware/auth');

const router = Router();

const createSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  tags: z.array(z.string()).optional()
});

// LIST: return all items (no owner filter)
router.get('/', requireAuth, async (_req, res, next) => {
  try {
    const rows = await db('core.items').orderBy('created_at', 'desc');
    res.json(rows);
  } catch (e) { next(e); }
});

// CREATE: no owner_id, optionally record created_by as the JWT sub if present
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const body = createSchema.parse(req.body);
    const createdBy = Number(req.user?.sub) || null; // optional

    const [row] = await db('core.items')
      .insert({
        name: body.name,
        description: body.description || null,
        tags: body.tags ? JSON.stringify(body.tags) : '[]',
        created_by: createdBy
      })
      .returning('*');

    res.status(201).json(row);
  } catch (e) { next(e); }
});

// UPDATE
router.patch('/:id', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const patch = req.body || {};
    if (patch.tags) patch.tags = JSON.stringify(patch.tags);

    const [row] = await db('core.items')
      .where({ id })
      .update({ ...patch, updated_at: db.fn.now() })
      .returning('*');

    res.json(row);
  } catch (e) { next(e); }
});

// DELETE
router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    await db('core.items').where({ id }).del();
    res.status(204).send();
  } catch (e) { next(e); }
});

// GET /stats?year=2022&quarter=1   (quarter optional)
router.get('/stats', requireAuth, async (req, res, next) => {
  try {
    const year = Number(req.query.year);
    const quarter = req.query.quarter != null && req.query.quarter !== ''
      ? Number(req.query.quarter)
      : null;

    if (!Number.isFinite(year)) {
      return res.status(400).json({ error: 'year is required and must be a number (e.g., 2022)' });
    }
    if (quarter != null && !(quarter >= 1 && quarter <= 4)) {
      return res.status(400).json({ error: 'quarter must be 1..4 if provided' });
    }

    // WITS trade_flow_code: 1 = Gross Import, 2 = Gross Export
    const FLOW = { GROSS_IMPORT: 1, GROSS_EXPORT: 2 };

    // Helper to constrain by year (+ optional quarter) on core.trade_data
    const byYearQuarter = (qb, alias = 'td') => {
      qb.where(`${alias}.period_year`, year);
      if (quarter != null) {
        qb.andWhereRaw(
          `CEIL(EXTRACT(MONTH FROM ${alias}.period_month)::numeric / 3) = ?`,
          [quarter]
        );
      }
    };

    // ---------- TOP LINE: exports / imports / totals ----------
    const topRows = await db('core.trade_data as td')
      .modify(byYearQuarter)
      .whereIn('td.trade_flow_code', [FLOW.GROSS_IMPORT, FLOW.GROSS_EXPORT])
      .select(
        db.raw(`SUM(CASE WHEN td.trade_flow_code = ? THEN td.value_usd ELSE 0 END) AS exports`, [FLOW.GROSS_EXPORT]),
        db.raw(`SUM(CASE WHEN td.trade_flow_code = ? THEN td.value_usd ELSE 0 END) AS imports`, [FLOW.GROSS_IMPORT])
      )
      .first();

    const toNum = v => (v == null ? 0 : Number(v));
    const exportsSum = toNum(topRows?.exports);
    const importsSum = toNum(topRows?.imports);
    const tradeValue = exportsSum + importsSum;
    const tradeBalance = exportsSum - importsSum;

    // ---------- DEEPDATA: per quarter totals ----------
    let Deepdata = {};
    if (quarter == null) {
      const qRows = await db('core.trade_data as td')
        .modify(byYearQuarter) // only year filter; quarter is rolled up below
        .whereIn('td.trade_flow_code', [FLOW.GROSS_IMPORT, FLOW.GROSS_EXPORT])
        .select(
          db.raw(`CEIL(EXTRACT(MONTH FROM td.period_month)::numeric / 3)::int AS q`),
          db.raw(`SUM(td.value_usd) AS amount`)
        )
        .groupBy('q')
        .orderBy('q', 'asc');

      Deepdata = qRows.reduce((acc, r) => {
        acc[`Q${r.q}`] = toNum(r.amount);
        return acc;
      }, {});
    } else {
      Deepdata = { [`Q${quarter}`]: tradeValue };
    }

    // ---------- COUNTRY DATA: by partner ----------
    // Ignore rows with null partner_id or missing partner name
    const countryRows = await db('core.trade_data as td')
      .modify(byYearQuarter)
      .whereIn('td.trade_flow_code', [FLOW.GROSS_IMPORT, FLOW.GROSS_EXPORT])
      .whereNotNull('td.partner_id')               // ✅ ignore null partner rows
      .leftJoin('core.trade_partners as tp', 'tp.id', 'td.partner_id')
      .whereNotNull('tp.name')                     // ✅ ignore nameless partners
      .select('tp.name as partner_name', 'td.partner_id')
      .select(
        db.raw(`SUM(CASE WHEN td.trade_flow_code = ? THEN td.value_usd ELSE 0 END) AS export`, [FLOW.GROSS_EXPORT]),
        db.raw(`SUM(CASE WHEN td.trade_flow_code = ? THEN td.value_usd ELSE 0 END) AS import`, [FLOW.GROSS_IMPORT])
      )
      .groupBy('tp.name', 'td.partner_id')
      .orderBy([{ column: 'tp.name', order: 'asc' }, { column: 'td.partner_id', order: 'asc' }]);

    const countryData = countryRows.reduce((acc, r) => {
      if (!r.partner_name) return acc;            // ✅ extra guard
      const label = r.partner_name;
      const exportVal = toNum(r.export);
      const importVal = toNum(r.import);
      acc[label] = {
        export: exportVal,
        import: importVal,
        totalTradeValue: exportVal + importVal
      };
      return acc;
    }, {});

    // ---------- REGIONAL DATA: by continent ----------
    // Ignore null partner_id and null continent to avoid "Unknown"
    const regionRows = await db('core.trade_data as td')
      .modify(byYearQuarter)
      .whereIn('td.trade_flow_code', [FLOW.GROSS_IMPORT, FLOW.GROSS_EXPORT])
      .whereNotNull('td.partner_id')               // ✅ ignore null partner rows
      .leftJoin('core.trade_partners as tp', 'tp.id', 'td.partner_id')
      .whereNotNull('tp.continent')                // ✅ ignore null continent
      .select('tp.continent as region')
      .sum({ tradeValue: 'td.value_usd' })
      .groupBy('tp.continent')
      .orderBy('tp.continent', 'asc');

    const regionalData = regionRows.reduce((acc, r) => {
      const key = r.region;
      if (!key) return acc;
      acc[key] = toNum(r.tradeValue);
      return acc;
    }, {});

    // ---------- RESPONSE ----------
    return res.json({
      tradeValue: Number(tradeValue),
      tradeBalance: Number(tradeBalance),
      exports: Number(exportsSum),
      imports: Number(importsSum),
      Deepdata: Object.fromEntries(Object.entries(Deepdata).map(([q,v]) => [q, Number(v)])),
      countryData: Object.fromEntries(Object.entries(countryData).map(([k,v]) => [k,{
        export: Number(v.export),
        import: Number(v.import),
        totalTradeValue: Number(v.totalTradeValue)
      }])),
      regionalData: Object.fromEntries(Object.entries(regionalData).map(([r,v]) => [r, Number(v)]))
    });
  } catch (e) {
    next(e);
  }
});

// GET /partners?withData=true&year=2022&quarter=1
router.get('/partners', requireAuth, async (req, res, next) => {
  try {
    const withData = String(req.query.withData || '').toLowerCase() === 'true';
    const year = req.query.year != null ? Number(req.query.year) : null;
    const quarter = req.query.quarter != null && req.query.quarter !== ''
      ? Number(req.query.quarter)
      : null;

    // validate quarter if provided
    if (quarter != null && !(quarter >= 1 && quarter <= 4)) {
      return res.status(400).json({ error: 'quarter must be 1..4 if provided' });
    }

    if (!withData) {
      // Return all partners (no data filter)
      const partners = await db('core.trade_partners')
        .select('id', 'name', 'iso3', 'continent')
        .orderBy('name', 'asc');

      return res.json(partners);
    }

    // Return only partners that have data for the given year[/quarter]
    if (!Number.isFinite(year)) {
      return res.status(400).json({ error: 'year is required when withData=true' });
    }

    // 1 = Gross Import, 2 = Gross Export
    const FLOW = { GROSS_IMPORT: 1, GROSS_EXPORT: 2 };

    const rows = await db('core.trade_data as td')
      .leftJoin('core.trade_partners as tp', 'tp.id', 'td.partner_id')
      .where('td.period_year', year)
      .whereIn('td.trade_flow_code', [FLOW.GROSS_IMPORT, FLOW.GROSS_EXPORT])
      .whereNotNull('td.partner_id')     // ✅ ignore null partner rows
      .whereNotNull('tp.name')           // ✅ ignore nameless partners
      .modify(qb => {
        if (quarter != null) {
          qb.andWhereRaw(
            'CEIL(EXTRACT(MONTH FROM td.period_month)::numeric / 3) = ?',
            [quarter]
          );
        }
      })
      .distinct('tp.id', 'tp.name', 'tp.iso3', 'tp.continent')
      .orderBy('tp.name', 'asc');

    return res.json(rows);
  } catch (e) {
    next(e);
  }
});

// GET /stats/continents?year=2022&quarter=1
router.get('/stats/continents', requireAuth, async (req, res, next) => {
  try {
    const year = Number(req.query.year);
    const quarter = req.query.quarter != null && req.query.quarter !== ''
      ? Number(req.query.quarter)
      : null;

    if (!Number.isFinite(year)) {
      return res.status(400).json({ error: 'year is required and must be a number (e.g., 2022)' });
    }
    if (quarter != null && !(quarter >= 1 && quarter <= 4)) {
      return res.status(400).json({ error: 'quarter must be 1..4 if provided' });
    }

    // 1 = Gross Import, 2 = Gross Export
    const FLOW = { GROSS_IMPORT: 1, GROSS_EXPORT: 2 };

    const rows = await db('core.trade_data as td')
      .leftJoin('core.trade_partners as tp', 'tp.id', 'td.partner_id')
      .where('td.period_year', year)
      .whereIn('td.trade_flow_code', [FLOW.GROSS_IMPORT, FLOW.GROSS_EXPORT])
      .whereNotNull('td.partner_id')     // ✅ ignore null partner rows
      .whereNotNull('tp.continent')      // ✅ ignore null continent
      .modify(qb => {
        if (quarter != null) {
          qb.andWhereRaw(
            'CEIL(EXTRACT(MONTH FROM td.period_month)::numeric / 3) = ?',
            [quarter]
          );
        }
      })
      .select('tp.continent')
      .sum({ tradeValue: 'td.value_usd' })
      .groupBy('tp.continent')
      .orderBy('tp.continent', 'asc');

    // Normalize to array of { continent, tradeValue }
    const result = rows.map(r => ({
      continent: r.continent,
      tradeValue: Number(r.tradeValue || 0)
    }));

    return res.json(result);
  } catch (e) {
    next(e);
  }
});

// GET /items/stats/top-exports?year=2022&limit=5
router.get('/stats/top-exports', requireAuth, async (req, res, next) => {
  try {
    const year = Number(req.query.year);
    const limit = Math.min(Math.max(Number(req.query.limit) || 5, 1), 50); // 1..50

    if (!Number.isFinite(year)) {
      return res.status(400).json({ error: 'year is required and must be a number (e.g., 2022)' });
    }

    // WITS codes: 2 = Gross Export
    const FLOW_EXPORT = 2;
    const prevYear = year - 1;

    // One pass: compute current + previous year exports per commodity, then rank by current
    const rows = await db('core.trade_data as td')
      .join('core.commodities as c', 'c.id', 'td.commodity_id')
      .where('td.trade_flow_code', FLOW_EXPORT)
      .whereIn('td.period_year', [prevYear, year])
      .groupBy('c.id', 'c.name', 'c.category')
      .select(
        'c.id as commodityId',
        'c.name as productName',
        'c.category as category',
        db.raw(`SUM(CASE WHEN td.period_year = ? THEN td.value_usd ELSE 0 END) AS cur`, [year]),
        db.raw(`SUM(CASE WHEN td.period_year = ? THEN td.value_usd ELSE 0 END) AS prev`, [prevYear])
      )
      .orderBy('cur', 'desc')
      .limit(limit);

    const fmtMoney = (val) => {
      const n = Number(val || 0);
      if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(0)}B`;
      if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(0)}M`;
      if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
      return `$${n.toFixed(0)}`;
    };

    const result = rows.map((r, i) => {
      const cur = Number(r.cur || 0);
      const prev = Number(r.prev || 0);
      const growthPct = prev > 0 ? ((cur - prev) / prev) * 100 : null;
      return {
        rank: i + 1,
        commodityId: r.commodityId,
        productName: r.productName,
        category: r.category || null,
        value: cur,
        valueFormatted: fmtMoney(cur),
        growthPct: growthPct == null ? null : Number(growthPct.toFixed(1)) // e.g. 18.0
      };
    });

    res.json(result);
  } catch (e) {
    next(e);
  }
});

// GET /market/opportunities?year=2024&commodityId=123&limit=10&q=coffee
router.get('/market/opportunities', requireAuth, async (req, res, next) => {
  try {
    // ----------------- params & guards -----------------
    const year = Number(req.query.year);
    if (!Number.isFinite(year)) {
      return res.status(400).json({ error: 'year is required (e.g., 2024)' });
    }

    const FLOW = { GROSS_IMPORT: 1, GROSS_EXPORT: 2 };

    // ----------------- resolve reporter (Rwanda) -----------------
    let RWANDA_ID = null;

    // 1) try ISO3 in trade_partners (case-insensitive)
    const rw = await db('core.trade_partners').select('id').whereILike('iso3', 'RWA').first();
    if (rw) RWANDA_ID = rw.id;

    // 2) fallback: most common reporter for this year
    if (!RWANDA_ID) {
      const probeYear = await db('core.trade_data as td')
        .select('td.reporter_id')
        .where('td.period_year', year)
        .whereNotNull('td.reporter_id')
        .groupBy('td.reporter_id')
        .orderByRaw('COUNT(*) DESC')
        .first();
      if (probeYear?.reporter_id) RWANDA_ID = probeYear.reporter_id;
    }

    // 3) fallback: most common reporter across all years
    if (!RWANDA_ID) {
      const probeAny = await db('core.trade_data as td')
        .select('td.reporter_id')
        .whereNotNull('td.reporter_id')
        .groupBy('td.reporter_id')
        .orderByRaw('COUNT(*) DESC')
        .first();
      if (probeAny?.reporter_id) RWANDA_ID = probeAny.reporter_id;
    }

    if (!RWANDA_ID) {
      return res.status(400).json({
        error: 'Cannot determine Rwanda reporter_id (no RWA row and no reporter in trade_data)',
      });
    }

    // ----------------- commodity filter (id and/or q) -----------------
    const q = String(req.query.q || '').trim();
    const commodityIdParam = req.query.commodityId ? Number(req.query.commodityId) : null;

    let commodityIds = [];
    if (commodityIdParam && Number.isFinite(commodityIdParam)) {
      commodityIds.push(commodityIdParam);
    }
    if (q) {
      const matches = await db('core.commodities')
        .select('id')
        .modify((qb) => {
          qb.whereILike('name', `%${q}%`).orWhereILike('code', `%${q}%`);
        })
        .limit(200);
      commodityIds.push(...matches.map((m) => m.id));
    }
    commodityIds = [...new Set(commodityIds)].filter((n) => Number.isFinite(n));

    const hasCommodityFilter = commodityIds.length > 0;

    // ----------------- limit (default depends on whether commodity filter is used) -----------------
    const limitParam = req.query.limit;
    const limitRaw = Number(limitParam);
    const defaultLimit = hasCommodityFilter ? 5 : 10;
    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(limitRaw, 1), 50)
      : defaultLimit;

    // ----------------- current year exports by partner -----------------
    const cur = db('core.trade_data as td')
      .leftJoin('core.trade_partners as tp', 'tp.id', 'td.partner_id')
      .where('td.period_year', year)
      .andWhere('td.reporter_id', RWANDA_ID)
      .andWhere('td.trade_flow_code', FLOW.GROSS_EXPORT)
      .whereNotNull('td.partner_id') // ✅ ignore null partner rows
      .whereNotNull('tp.name')       // ✅ ignore nameless partners
      .modify((qb) => {
        if (hasCommodityFilter) qb.whereIn('td.commodity_id', commodityIds);
      })
      .groupBy('td.partner_id', 'tp.name', 'tp.iso3')
      .select(
        'td.partner_id',
        'tp.name as partner_name',
        'tp.iso3 as partner_iso3',
        db.raw('SUM(td.value_usd) AS value_usd'),
        db.raw(`
          SUM(td.value_usd) /
          NULLIF(
            SUM(
              CASE WHEN (td.quantity_unit = 'kg' OR td.unit = 'kg')
                   THEN COALESCE(td.quantity, 0)
                   ELSE 0
              END
            ), 0
          ) AS avg_price_per_kg
        `)
      );

    // ----------------- previous year for growth -----------------
    const prev = db('core.trade_data as td')
      .where('td.period_year', year - 1)
      .andWhere('td.reporter_id', RWANDA_ID)
      .andWhere('td.trade_flow_code', FLOW.GROSS_EXPORT)
      .whereNotNull('td.partner_id') // ✅ ignore null partner rows
      .modify((qb) => {
        if (hasCommodityFilter) qb.whereIn('td.commodity_id', commodityIds);
      })
      .groupBy('td.partner_id')
      .select('td.partner_id', db.raw('SUM(td.value_usd) AS prev_value_usd'));

    // ----------------- join & shape -----------------
    const rows = await db.from(cur.as('c'))
      .leftJoin(prev.as('p'), 'p.partner_id', 'c.partner_id')
      .select(
        'c.partner_id',
        'c.partner_name',
        'c.partner_iso3',
        db.raw('COALESCE(c.value_usd, 0) AS market_size_usd'),
        db.raw('COALESCE(c.avg_price_per_kg, NULL) AS avg_price_per_kg'),
        db.raw(`
          CASE
            WHEN p.prev_value_usd IS NULL OR p.prev_value_usd = 0 THEN NULL
            ELSE ROUND(100.0 * (c.value_usd - p.prev_value_usd) / p.prev_value_usd, 1)
          END AS growth_pct
        `)
      )
      .orderBy('market_size_usd', 'desc')
      .limit(limit);

    const result = rows.map((r) => {
      const ms = Number(r.market_size_usd || 0);
      const g = r.growth_pct == null ? null : Number(r.growth_pct);
      const badge =
        g != null && g >= 10 && ms >= 10_000_000
          ? 'High Opportunity'
          : g != null && g >= 0
          ? 'Growing'
          : 'Neutral';

      return {
        partnerId: r.partner_id,
        partnerName: r.partner_name ?? `#${r.partner_id}`,
        iso3: r.partner_iso3,
        marketSize: ms,
        averagePricePerKg: r.avg_price_per_kg == null ? null : Number(r.avg_price_per_kg),
        growthPct: g,
        tariffRate: null,
        badge,
      };
    });

    return res.json(result);
  } catch (e) {
    next(e);
  }
});

// GET /commodities?q=tea&limit=20&offset=0
router.get('/commodities', requireAuth, async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 100);
    const offset = Math.max(Number(req.query.offset || 0), 0);

    const rows = await db('core.commodities as c')
      .modify(qb => {
        if (q) {
          qb.whereILike('c.name', `%${q}%`)
            .orWhereILike('c.code', `%${q}%`)
            .orWhereILike('c.category', `%${q}%`); // searched, but not returned
        }
      })
      .select(
        'c.id',
        'c.code',
        db.raw(`COALESCE(NULLIF(c.name, ''), c.code) AS name`)
      )
      .orderBy([
        { column: db.raw(`COALESCE(NULLIF(c.name,''), c.code)`), order: 'asc' },
        { column: 'c.code', order: 'asc' }
      ])
      .limit(limit)
      .offset(offset);

    res.json(rows);
  } catch (e) {
    next(e);
  }
});

// POST /items/whatif/simulate
router.post('/whatif/simulate', requireAuth, async (req, res, next) => {
  try {
    const body = req.body || {};
    const year = Number(body.year);
    const exportChangePct = Number(body.exportChangePct);
    const name = typeof body.name === 'string' ? body.name.trim() : null;

    // Normalize & validate partner/commodity filters
    const partnerIso3 = (body.partnerIso3 || '').trim().toUpperCase() || null;
    const commodityIdRaw = body.commodityId;
    const commodityId = (commodityIdRaw === undefined || commodityIdRaw === null)
      ? null
      : Number(commodityIdRaw);

    if (!Number.isFinite(year)) {
      return res.status(400).json({ error: 'year is required (e.g., 2022)' });
    }
    if (!Number.isFinite(exportChangePct)) {
      return res.status(400).json({ error: 'exportChangePct is required (number, can be negative)' });
    }
    if (partnerIso3 && !/^[A-Z]{3}$/.test(partnerIso3)) {
      return res.status(400).json({ error: 'partnerIso3 must be a 3-letter ISO3 code, e.g. ZAF' });
    }
    if (commodityId !== null && !Number.isFinite(commodityId)) {
      return res.status(400).json({ error: 'commodityId must be an integer when provided' });
    }

    // WITS codes
    const FLOW = { GROSS_IMPORT: 1, GROSS_EXPORT: 2 };

    // --- Resolve Rwanda reporter_id (required) ---
    let RWANDA_ID = null;
    const rw = await db('core.trade_partners')
      .select('id')
      .whereRaw('UPPER(iso3) = UPPER(?)', ['RWA'])
      .first();
    if (rw) RWANDA_ID = Number(rw.id);

    if (!RWANDA_ID) {
      const probe = await db('core.trade_data as td')
        .select('td.reporter_id')
        .where('td.period_year', year)
        .whereNotNull('td.reporter_id')
        .groupBy('td.reporter_id')
        .orderByRaw('COUNT(*) DESC')
        .first();
      if (probe?.reporter_id) RWANDA_ID = Number(probe.reporter_id);
    }
    if (!RWANDA_ID) {
      return res.status(400).json({ error: 'Cannot determine Rwanda reporter_id' });
    }

    // --- Resolve partner (optional, but if provided must exist) ---
    let partnerIdFilter = null;
    let partnerResolved = null;
    if (partnerIso3) {
      const p = await db('core.trade_partners')
        .select('id')
        .whereRaw('UPPER(iso3) = UPPER(?)', [partnerIso3])
        .first();
      partnerResolved = !!p;
      if (!p) {
        return res.status(400).json({ error: `Unknown partnerIso3: ${partnerIso3}` });
      }
      partnerIdFilter = Number(p.id);
    }

    // (Optional) Check commodity existence for better diagnostics (does not 400)
    let commodityResolved = null;
    if (commodityId !== null) {
      const c = await db('core.commodities').select('id').where({ id: commodityId }).first();
      commodityResolved = !!c;
      // If commodity doesn’t exist, we still proceed; slice will be zero and meta will explain.
    }

    // --- Current (baseline) totals for Rwanda & year ---
    const curRow = await db('core.trade_data as td')
      .where('td.reporter_id', RWANDA_ID)
      .andWhere('td.period_year', year)
      .whereIn('td.trade_flow_code', [FLOW.GROSS_IMPORT, FLOW.GROSS_EXPORT])
      .select(
        db.raw(`SUM(CASE WHEN td.trade_flow_code = ? THEN td.value_usd ELSE 0 END) AS exports`, [FLOW.GROSS_EXPORT]),
        db.raw(`SUM(CASE WHEN td.trade_flow_code = ? THEN td.value_usd ELSE 0 END) AS imports`, [FLOW.GROSS_IMPORT])
      )
      .first();

    const toNum = (v) => (v == null ? 0 : Number(v));
    const currentExports = toNum(curRow?.exports);
    const currentImports = toNum(curRow?.imports);
    const currentBalance = currentExports - currentImports;

    // --- Slice baseline: sum of exports for the selected slice (partner/commodity) ---
    const sliceQB = db('core.trade_data as td')
      .where('td.reporter_id', RWANDA_ID)
      .andWhere('td.period_year', year)
      .andWhere('td.trade_flow_code', FLOW.GROSS_EXPORT);

    if (partnerIdFilter !== null) sliceQB.andWhere('td.partner_id', partnerIdFilter);
    if (commodityId !== null) sliceQB.andWhere('td.commodity_id', commodityId);

    const sliceRow = await sliceQB
      .select(db.raw('SUM(td.value_usd) AS slice_exports'))
      .first();

    const sliceExports = toNum(sliceRow?.slice_exports);
    const sliceFound = sliceExports > 0;

    // --- Apply uplift only to the slice ---
    const uplift = sliceExports * (exportChangePct / 100.0);
    const scenarioExports = currentExports + uplift;
    const scenarioImports = currentImports; // unchanged
    const scenarioBalance = scenarioExports - scenarioImports;

    const result = {
      inputs: {
        year,
        partnerIso3: partnerIso3 || null,
        commodityId: commodityId === null ? null : commodityId,
        exportChangePct: Number(exportChangePct),
        name: name || null
      },
      current: {
        exports: currentExports,
        imports: currentImports,
        balance: currentBalance
      },
      scenario: {
        exports: scenarioExports,
        imports: scenarioImports,
        balance: scenarioBalance
      },
      deltas: {
        exportsDelta: scenarioExports - currentExports,
        importsDelta: scenarioImports - currentImports,
        balanceDelta: scenarioBalance - currentBalance
      },
      chart: [
        { name: 'Current', export: currentExports, import: currentImports },
        { name: 'Scenario', export: scenarioExports, import: scenarioImports }
      ],
      meta: {
        reporterId: RWANDA_ID,
        sliceFound,
        sliceExportsBaseline: sliceExports,
        partnerResolved,
        commodityResolved
      }
    };

    return res.json(result);
  } catch (e) {
    next(e);
  }
});


module.exports = router;
