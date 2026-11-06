function gate(flag, val) {
  if (flag == true) {
    return val * 2;
  }
  return val;
}
module.exports = { gate };
