export const PLANS = [
  { id: "free", name: "Free", dailyLimit: 1000, monthlyLimit: 30000 },
  { id: "standard", name: "Standard", dailyLimit: 5000, monthlyLimit: 150000 },
  { id: "plus", name: "Plus", dailyLimit: 10000, monthlyLimit: 300000 },
  { id: "premium", name: "Premium", dailyLimit: 20000, monthlyLimit: 600000 },
  { id: "custom", name: "Custom", dailyLimit: null, monthlyLimit: null },
];

const PLAN_IDS = new Set(PLANS.map((plan) => plan.id));

export function isPlanId(value) {
  return PLAN_IDS.has(String(value || ""));
}

export function planById(id) {
  return PLANS.find((plan) => plan.id === id) || PLANS.find((plan) => plan.id === "standard") || PLANS[0];
}

function parseCustomLimit(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export function dailyLimitFor(user) {
  const planId = isPlanId(user?.plan) ? user.plan : "standard";
  if (planId === "custom") return parseCustomLimit(user?.customDailyLimit);
  return Number(planById(planId).dailyLimit) || 0;
}

export function monthlyLimitFor(user) {
  const planId = isPlanId(user?.plan) ? user.plan : "standard";
  if (planId === "custom") return parseCustomLimit(user?.customMonthlyLimit);
  return Number(planById(planId).monthlyLimit) || 0;
}

export function planPublic(user) {
  const planId = isPlanId(user?.plan) ? user.plan : "standard";
  const plan = planById(planId);
  return {
    plan: planId,
    planName: plan.name,
    dailyLimit: dailyLimitFor(user),
    monthlyLimit: monthlyLimitFor(user),
  };
}

export function publicPlans() {
  return PLANS.map((plan) => ({
    id: plan.id,
    name: plan.name,
    dailyLimit: plan.dailyLimit,
    monthlyLimit: plan.monthlyLimit,
  }));
}
