import io
import random
import numpy as np
import pandas as pd
from scipy import stats
from sklearn.linear_model import LinearRegression
from statsmodels.api import OLS
from ortools.sat.python import cp_model
from matplotlib import pyplot as plt

random.seed(1)
np.random.seed(1)
demand = pd.Series(fixture["units"], name="units")
period = np.arange(1, 4)
model = LinearRegression().fit(period.reshape(-1, 1), demand)
assert abs(OLS(demand, period).fit().params.iloc[0] - 3) < 1e-9
assert stats.linregress(period, demand).slope == 3
solver = cp_model.CpSolver()
solver.parameters.num_search_workers = 1
solver.parameters.random_seed = 1
plan = cp_model.CpModel()
quantity = plan.new_int_var(0, 20, "quantity")
plan.add(quantity >= int(round(model.predict([[4]])[0])))
plan.minimize(quantity)
assert solver.solve(plan) == cp_model.OPTIMAL
qty = solver.value(quantity)
emit_table({"columns": [{"id": "period", "type": "integer"}, {"id": "units", "type": "integer"}],
            "rows": [[4, qty]]})
fig, axes = plt.subplots(figsize=(3, 2), dpi=80)
axes.plot([1, 2, 3, 4], [3, 6, 9, qty])
axes.set(ylabel="Units", xlabel="Period")
buf = io.BytesIO()
fig.savefig(buf, format="png")
emit_png(buf.getvalue())
emit_text(f"Fixed fixture projects {qty} units in period 4.")
