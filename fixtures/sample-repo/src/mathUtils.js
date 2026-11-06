function isEven(n) {
  return n % 2 == 0;
}
function clampPositive(n) {
  if (n < 0) return 0;
  return n;
}
module.exports = { isEven, clampPositive };
