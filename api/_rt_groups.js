// Fixed set of dev_groups.name values this isolated "RT" dashboard system is scoped to.
// Note: the originally supplied "T_Vivo" does not exist in dev_groups; "RT_Vivo" does
// and matches the RT_/rt_ naming pattern of the other 8 groups, so it's used here instead.
module.exports = [
  'RT_Huawei',
  'RT_Xiaomi',
  'RT_Windows',
  'RT_Samsung',
  'rt_ios',
  'RT_Vivo',
  'RT_OPPO',
  'RT_Amazon',
  'rt_android',
];
