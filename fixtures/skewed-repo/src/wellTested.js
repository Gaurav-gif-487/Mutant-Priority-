function classify(n) {
  if (n == 0) return "zero";
  if (n > 0 && n < 10) return "small";
  if (n >= 10 || n < -10) return "large";
  return n === -1 ? "neg-one" : "other";
}
module.exports = { classify };
