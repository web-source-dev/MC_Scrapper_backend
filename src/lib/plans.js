export const PLANS = [
  { id: "standard", name: "Standard", dailyLimit: 5000 },
  { id: "plus", name: "Plus", dailyLimit: 10000 },
  { id: "premium", name: "Premium", dailyLimit: 20000 },
  { id: "custom", name: "Custom", dailyLimit: null },
];

const PLAN_IDS = new Set(PLANS.map((plan) => plan.id));

export function isPlanId(value) {
  return PLAN_IDS.has(String(value || ""));
}

export function planById(id) {
  return PLANS.find((plan) => plan.id === id) || PLANS[0];
}

export function dailyLimitFor(user) {
  const planId = isPlanId(user?.plan) ? user.plan : "standard";
  if (planId === "custom") {
    const custom = Number.parseInt(String(user?.customDailyLimit ?? ""), 10);
    return Number.isFinite(custom) && custom >= 0 ? custom : 0;
  }
  return Number(planById(planId).dailyLimit) || 0;
}

export function planPublic(user) {
  const planId = isPlanId(user?.plan) ? user.plan : "standard";
  const plan = planById(planId);
  return {
    plan: planId,
    planName: plan.name,
    dailyLimit: dailyLimitFor(user),
  };
}
