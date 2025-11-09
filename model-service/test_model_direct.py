"""
Direct test of the model to identify the exact error
"""
import json
import joblib
import numpy as np
import pandas as pd

# Load the model
MODEL = joblib.load("models/model.pkl")
with open("models/model.meta.json") as f:
    META = json.load(f)

XCOLS = META["XCOLS"]
print("Expected columns:", XCOLS)
print("\nModel type:", type(MODEL))
print("Model steps:", MODEL.steps if hasattr(MODEL, 'steps') else "Not a pipeline")

# Create a simple test input matching XCOLS
test_data = {
    "Partner ISO3": ["USA"],
    "YoY_pct": [0.05],
    "lag_1": [10.0],
    "lag_2": [9.5],
    "roll2_mean": [9.75],
    "roll2_std": [0.25],
    "year_index": [5.0]
}

X_test = pd.DataFrame(test_data)
print("\nTest input shape:", X_test.shape)
print("Test input dtypes:\n", X_test.dtypes)
print("\nTest data:")
print(X_test)

try:
    prediction = MODEL.predict(X_test)
    print("\n✓ SUCCESS! Prediction:", prediction)
except Exception as e:
    print(f"\n✗ ERROR: {type(e).__name__}: {e}")
    import traceback
    traceback.print_exc()
