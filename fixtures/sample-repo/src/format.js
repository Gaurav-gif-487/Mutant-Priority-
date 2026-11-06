const { isEven } = require("./mathUtils");
const { isBlank } = require("./stringUtils");

function describe(n, label) {
  if (isBlank(label) || n == null) return "unknown";
  const parity = isEven(n) ? "even" : "odd";
  return `${label}: ${n} (${parity})`;
}
module.exports = { describe };
