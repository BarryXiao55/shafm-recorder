/*
 * plan-prefix.js — 节目单文件名前缀的唯一真相来源（零依赖，前后端共用）
 *
 * 约定：文件名前缀跟随电台频率，例如 FM 99.0 → FM990、FM 105.7 → FM1057、
 *       FM 90.9 → FM909、FM 87.9 → FM879。
 *
 * 历史缺陷（v3.1.9 及之前）：validatePlan 完全信任前端传来的 filePrefix，
 * 服务端不做电台反查；定时节目单表单选电台后前缀框不联动、编辑旧计划时
 * 残留上一次的前缀、快捷模板不带电台、只填流地址不带电台，这四类计划
 * 最终都会由 planJobConfig 回退到全局 config.filePrefix（本机为 FM990），
 * 于是「不同电台的定时任务录出同一个前缀」。
 *
 * 本模块以 UMD 方式写成：Node 端 require('./public/plan-prefix.js')，
 * 浏览器端通过 <script src="/plan-prefix.js"> 暴露为 window.PlanPrefix，
 * 保证「添加节目单」与「节目单触发录制」使用完全相同的规则。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PlanPrefix = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** Windows 文件名非法字符 + 百分号（ffmpeg segment 模板会解释 %）。 */
  var BAD = /[\\/:*?"<>|%\r\n\t]/g;

  function cleanPrefix(v) {
    return String(v == null ? '' : v).trim().replace(BAD, '_').slice(0, 24);
  }

  /** FM 频率 → 文件名前缀：FM 99.0 → FM990、FM 105.7 → FM1057。 */
  function prefixFromFreq(freq) {
    var m = String(freq || '').match(/FM\s*(\d+(?:\.\d+)?)/i);
    return m ? 'FM' + m[1].replace(/\./g, '') : '';
  }

  /** 与 lib/stations.js 的 prefixFor 保持一致：显式配置优先，否则按频率推导。 */
  function prefixOf(s) {
    var configured = cleanPrefix(s && s.prefix);
    if (configured && configured !== 'REC') return configured;
    return prefixFromFreq(s && s.freq) || configured || 'REC';
  }

  /** URL 归一化：去协议 / 查询串 / 结尾斜杠，便于匹配电台库的 url 与 backup。 */
  function normalizeUrl(u) {
    return String(u == null ? '' : u).trim().toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/[?#].*$/, '')
      .replace(/\/+$/, '');
  }

  function stationByUrl(list, url) {
    var key = normalizeUrl(url);
    if (!key) return null;
    return (list || []).find(function (s) {
      return [s.url, s.backup].some(function (x) { return normalizeUrl(x) === key; });
    }) || null;
  }

  function findStation(list, plan) {
    var p = plan || {};
    if (p.stationId) {
      var hit = (list || []).find(function (s) { return s.id === p.stationId; });
      if (hit) return { station: hit, by: 'station' };
    }
    var byUrl = stationByUrl(list, p.streamUrl);
    if (byUrl) return { station: byUrl, by: 'url' };
    return { station: null, by: '' };
  }

  /**
   * 决策：这条节目单应当用哪个前缀。
   * @param {object} plan  { stationId, streamUrl, filePrefix, prefixManual?, prefixMode? }
   * @param {array}  list  电台库（每项含 id/name/freq/prefix/url/backup）
   * @param {string} fallback 无法识别电台时的兜底前缀（通常是全局 config.filePrefix）
   * @returns {{filePrefix:string, stationId:string, prefixMode:string,
   *            expected:string, stationName:string, matchedBy:string,
   *            inferredStation:boolean, changed:boolean, custom:boolean}}
   *
   * 优先级：
   *   1. stationId（或按 streamUrl 反查）能识别电台 → 频率前缀（强制校正）
   *   2. 用户显式 prefixManual=true 且填了前缀 → 尊重自定义（唯一例外）
   *   3. 识别不到电台 → 手填前缀，否则沿用全局兜底
   */
  function decide(plan, list, fallback) {
    var p = plan || {};
    var given = cleanPrefix(p.filePrefix);
    var manual = p.prefixManual === true || p.prefixMode === 'manual';
    var found = findStation(list, p);
    var s = found.station;

    if (s) {
      var expected = prefixOf(s);
      var custom = manual && !!given;
      var chosen = custom ? given : expected;
      return {
        filePrefix: chosen,
        stationId: s.id,
        prefixMode: custom ? 'manual' : 'auto',
        expected: expected,
        stationName: s.name || '',
        matchedBy: found.by,
        inferredStation: !p.stationId && found.by === 'url',
        changed: given !== chosen,
        custom: custom
      };
    }
    var final = given || cleanPrefix(fallback) || 'REC';
    return {
      filePrefix: final,
      stationId: String(p.stationId || ''),
      prefixMode: given ? 'manual' : 'fallback',
      expected: '',
      stationName: '',
      matchedBy: '',
      inferredStation: false,
      changed: given !== final,
      custom: !!given
    };
  }

  /** 返回规整后的 plan 副本：只改 filePrefix / stationId / prefixMode，不删任何字段。 */
  function normalizePlan(plan, list, fallback) {
    var d = decide(plan, list, fallback);
    var out = Object.assign({}, plan || {}, {
      filePrefix: d.filePrefix,
      stationId: d.stationId,
      prefixMode: d.prefixMode
    });
    delete out.prefixManual;
    return out;
  }

  /** 供 UI 展示「为什么是这个前缀」的诊断信息。 */
  function explain(plan, list, fallback) {
    return decide(plan, list, fallback);
  }

  return {
    cleanPrefix: cleanPrefix,
    prefixFromFreq: prefixFromFreq,
    prefixOf: prefixOf,
    normalizeUrl: normalizeUrl,
    stationByUrl: stationByUrl,
    decide: decide,
    explain: explain,
    normalizePlan: normalizePlan
  };
});
