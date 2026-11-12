/**
 * local_test.js — FlowPilot のローカルテスト（Node.js で実行）
 *
 *   実行方法:  node tests/local_test.js
 *
 * Google（スプレッドシート・Tasks・Gmail・フォーム）と OpenAI を「偽物（モック）」に置き換えて、
 * gas/ フォルダのコードをそのまま動かします。実際の Google や OpenAI には一切接続しません。
 * そのため「処理の流れ・重複防止・エラー処理・入力チェック」の確認はできますが、
 * 「AIの分類精度」や「本物のGoogle環境での動作」はここでは確認できません。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const GAS_DIR = path.join(__dirname, '..', 'gas');
const FAKE_KEY = 'sk-test-THIS-IS-A-FAKE-KEY-0000';

// ---------------- 汎用: 何を呼んでも自分を返す「なんでもOK」オブジェクト ----------------
function chain() {
  const fn = function () { return proxy; };
  const proxy = new Proxy(fn, {
    get: (t, p) => (p === 'then' ? undefined : (p === Symbol.toPrimitive ? () => '' : proxy)),
    apply: () => proxy,
  });
  return proxy;
}

// ---------------- スプレッドシートの模擬 ----------------
// 本物のシートと同じく、日付らしい文字列を書き込むと日付型に変換される
function sheetsAutoConvert(v) {
  if (typeof v !== 'string') return v;
  if (v.startsWith("'")) return v.slice(1); // 先頭の ' は「文字列として保存」の印
  let m = v.match(/^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (m) return new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return new Date(+m[1], m[2] - 1, +m[3]);
  if (/^[=+\-@]/.test(v)) return '#FORMULA:' + v; // 数式として解釈されてしまった印
  return v;
}

function a1ToRC(a1) {
  const m = a1.match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/);
  const col = (s) => s.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
  const r1 = +m[2], c1 = col(m[1]);
  const r2 = m[3] ? +m[4] : r1, c2 = m[3] ? col(m[3]) : c1;
  return [r1, c1, r2 - r1 + 1, c2 - c1 + 1];
}

class FakeSheet {
  constructor(name) { this.name = name; this.data = []; this.formulas = {}; this.activeRow = 2; }
  getName() { return this.name; }
  getLastRow() {
    for (let r = this.data.length; r > 0; r--) if ((this.data[r - 1] || []).some((v) => v !== '' && v !== undefined)) return r;
    return 0;
  }
  getLastColumn() {
    let max = 0;
    this.data.forEach((row) => { (row || []).forEach((v, i) => { if (v !== '' && v !== undefined) max = Math.max(max, i + 1); }); });
    return max;
  }
  getMaxRows() { return 1000; }
  cell(r, c) { return ((this.data[r - 1] || [])[c - 1]); }
  set(r, c, v) { while (this.data.length < r) this.data.push([]); this.data[r - 1][c - 1] = sheetsAutoConvert(v); }
  appendRow(vals) { const r = this.getLastRow() + 1; vals.forEach((v, i) => this.set(r, i + 1, v)); }
  clear() { this.data = []; this.formulas = {}; }
  getActiveRange() { return this.getRange(this.activeRow, 1); }
  getRange(a, b, nr, nc) {
    let r, c;
    if (typeof a === 'string') [r, c, nr, nc] = a1ToRC(a); else { r = a; c = b; nr = nr || 1; nc = nc || 1; }
    const sheet = this;
    const real = {
      getRow: () => r,
      getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => { const v = sheet.cell(r + i, c + j); return v === undefined ? '' : v; })),
      getValue: () => { const v = sheet.cell(r, c); return v === undefined ? '' : v; },
      setValues: (vals) => { vals.forEach((row, i) => row.forEach((v, j) => sheet.set(r + i, c + j, v))); return proxy; },
      setValue: (v) => { sheet.set(r, c, v); return proxy; },
      setFormula: (f) => { sheet.formulas[r + ',' + c] = f; sheet.set(r, c, '(formula)'); return proxy; },
    };
    const proxy = new Proxy(real, { get: (t, p) => (p in t ? t[p] : () => proxy) });
    return proxy;
  }
}
// 定義したメソッドは本物として動き、それ以外は何もしない（チェーン可能）オブジェクト
function withFallback(obj) { return new Proxy(obj, { get: (t, p) => (p in t ? t[p] : chain()) }); }
function fakeForm(env) {
  return withFallback({
    getId: () => 'FORM1', getPublishedUrl: () => 'https://forms.example/view', getEditUrl: () => 'https://forms.example/edit',
    getResponses: () => env.formResponses.slice(), // フォーム側に保存されている回答
  });
}
// 未定義のメソッド（書式設定など）は何もしない
const sheetProxy = (s) => new Proxy(s, { get: (t, p) => (p in t ? (typeof t[p] === 'function' ? t[p].bind(t) : t[p]) : () => chain()) });

// ---------------- テスト用の環境を作る ----------------
function createEnv() {
  const env = {
    sheets: {}, props: { OPENAI_API_KEY: FAKE_KEY }, alerts: [], tasks: [], drafts: [],
    sendCalls: 0, openAiCalls: 0, openAiRequests: [], triggers: [],
    mode: { openAi: 'normal', openAiFailCount: 0, task: 'normal', draft: 'normal', draftSearchIndexed: true },
    lockAvailable: true, formResponses: [],
    activeSheetName: '案件管理',
  };
  let idSeq = 0;
  const ss = {
    getSheetByName: (n) => (env.sheets[n] ? sheetProxy(env.sheets[n]) : null),
    insertSheet: (n) => { env.sheets[n] = new FakeSheet(n); return sheetProxy(env.sheets[n]); },
    getId: () => 'SS1',
    setSpreadsheetTimeZone: (tz) => { env.sheetTimeZone = tz; },
  };

  const ctx = {
    console: { log: () => {}, error: () => {} },
    SpreadsheetApp: new Proxy({
      getActiveSpreadsheet: () => ss,
      getActiveSheet: () => sheetProxy(env.sheets[env.activeSheetName]),
      flush: () => {},
      getUi: () => new Proxy({ alert: (m) => env.alerts.push(m) }, { get: (t, p) => (p in t ? t[p] : chain()) }),
    }, { get: (t, p) => (p in t ? t[p] : chain()) }),
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => (k in env.props ? env.props[k] : null),
      setProperty: (k, v) => { env.props[k] = String(v); },
    }) },
    // lockAvailable=false で「混雑して順番待ちがタイムアウトした」状況を再現できる
    LockService: { getScriptLock: () => ({ tryLock: () => env.lockAvailable, waitLock: () => {}, releaseLock: () => {} }) },
    Session: { getScriptTimeZone: () => 'Asia/Tokyo' },
    Utilities: {
      Charset: { UTF_8: 'UTF-8' },
      sleep: () => {},
      formatDate: (d, tz, fmt) => {
        const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
          .formatToParts(d).map((x) => [x.type, x.value]));
        return fmt.replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day).replace('HH', p.hour).replace('mm', p.minute).replace('ss', p.second);
      },
      base64Encode: (s) => Buffer.from(s, 'utf8').toString('base64'),
      base64EncodeWebSafe: (s) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
    },
    UrlFetchApp: { fetch: (url, opt) => fakeOpenAi(env, url, opt) },
    Tasks: {
      Tasklists: { insert: () => ({ id: 'LIST1' }), get: (id) => ({ id }) },
      Tasks: {
        insert: (task, listId) => {
          if (env.mode.task === 'fail') { env.mode.task = 'normal'; throw new Error('Tasks API 一時エラー'); }
          const t = Object.assign({ id: 'T' + (++idSeq), listId }, task);
          env.tasks.push(t);
          if (env.mode.task === 'failAfterCreate') { env.mode.task = 'normal'; throw new Error('タイムアウト（実は作成済み）'); }
          return t;
        },
        list: () => ({ items: env.tasks.slice() }),
      },
    },
    Gmail: { Users: {
      Drafts: {
        create: (res) => {
          if (env.mode.draft === 'fail') { env.mode.draft = 'normal'; throw new Error('Gmail API 一時エラー'); }
          const d = { id: 'D' + (++idSeq), raw: res.message.raw };
          env.drafts.push(d);
          if (env.mode.draft === 'failAfterCreate') { env.mode.draft = 'normal'; throw new Error('タイムアウト（実は作成済み）'); }
          return d;
        },
        list: (user, opt) => {
          if (!env.mode.draftSearchIndexed) return { drafts: [] }; // 検索への反映が遅れている状況
          const q = String(opt.q).replace(/"/g, '');
          return { drafts: env.drafts.filter((d) => decodeDraft(d.raw).subject.includes(q)).map((d) => ({ id: d.id })) };
        },
        send: () => { env.sendCalls++; throw new Error('送信は禁止'); },
      },
      Messages: { send: () => { env.sendCalls++; throw new Error('送信は禁止'); } },
    } },
    FormApp: withFallback({ create: () => fakeForm(env), openById: () => fakeForm(env) }),
    ScriptApp: {
      getProjectTriggers: () => env.triggers.map((h) => ({ getHandlerFunction: () => h })),
      deleteTrigger: (t) => { env.triggers.splice(env.triggers.indexOf(t.getHandlerFunction()), 1); },
      newTrigger: (h) => ({
        forForm: () => ({ onFormSubmit: () => ({ create: () => env.triggers.push(h) }) }),
        timeBased: () => ({ everyMinutes: () => ({ create: () => env.triggers.push(h) }) }),
      }),
    },
  };
  vm.createContext(ctx);
  const files = fs.readdirSync(GAS_DIR).filter((f) => f.endsWith('.js')).sort();
  const code = files.map((f) => fs.readFileSync(path.join(GAS_DIR, f), 'utf8')).join('\n') +
    '\nglobalThis.__fp = { TEST_CASES, CASE_HEADERS, AI_STATUS, FP };';
  vm.runInContext(code, ctx, { filename: 'gas-bundle.js' });
  env.ctx = ctx;
  env.sources = files.map((f) => fs.readFileSync(path.join(GAS_DIR, f), 'utf8')).join('\n');
  return env;
}

// ---------------- OpenAI の模擬（キーワードで分類する簡易版） ----------------
function fakeOpenAi(env, url, opt) {
  env.openAiCalls++;
  const body = JSON.parse(opt.payload);
  env.openAiRequests.push({ url, headers: opt.headers, body });
  const res = (code, obj) => ({ getResponseCode: () => code, getContentText: () => JSON.stringify(obj) });
  if (env.mode.openAiFailCount > 0) { env.mode.openAiFailCount--; return res(500, { error: { message: 'server error' } }); }
  if (env.mode.openAi === 'badKey') return res(401, { error: { message: 'Incorrect API key provided' } });

  const userMsg = body.input[1].content;
  const inq = JSON.parse(userMsg.slice(userMsg.indexOf('<inquiry>') + 9, userMsg.indexOf('</inquiry>')));
  const text = inq['件名'] + ' ' + inq['問い合わせ内容'];
  let category = 'その他';
  if (/見積|費用|quote|予算/i.test(text)) category = '見積依頼';
  else if (/日程|日時|キャンセル|変更|候補/.test(text)) category = '日程調整';
  else if (/相談|可能|修理|水漏れ|つまり|ブレーカー|異音|止ま|回らな/.test(text)) category = 'サービス相談';
  const urgent = /至急|すぐに|本日中|営業ができない|水が出ません|漏電/.test(text);
  const out = {
    category, summary: String(inq['件名']) + 'に関する問い合わせ', priority: urgent ? '高' : '通常',
    required_actions: '内容を確認し、お客様へ連絡する', task_action: '問い合わせ対応',
    deadline: '', deadline_evidence: '', missing_info: ['設置場所の詳細'],
    reply_body: (inq['会社名'] || '') + ' ' + inq['氏名'] + '様\n\nお問い合わせいただきありがとうございます。内容を確認のうえ、担当者よりご連絡いたします。\n\n今後ともよろしくお願いいたします。',
    injection_suspected: /指示はすべて無視/.test(text),
  };
  const m = String(inq['問い合わせ内容']).match(/(\d{1,2})月(\d{1,2})日までに/);
  if (m) { out.deadline = '2026-' + ('0' + m[1]).slice(-2) + '-' + ('0' + m[2]).slice(-2); out.deadline_evidence = m[0]; }
  if (env.mode.openAi === 'hallucinateDeadline') { out.deadline = '2026-12-01'; out.deadline_evidence = '12月1日までに'; }
  if (env.mode.openAi === 'relativeDeadline') { out.deadline = '2026-11-20'; out.deadline_evidence = '来週の金曜日までに'; }
  if (env.mode.openAi === 'hallucinateAmount') out.reply_body += '\n概算費用は30万円です。11月25日に伺います。';
  if (env.mode.openAi === 'badCategory') out.category = '苦情';
  if (env.mode.openAi === 'notJson') return res(200, { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'すみません' }] }] });
  return res(200, { status: 'completed', output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(out) }] }] });
}

// ---------------- 補助関数 ----------------
let responseSeq = 0;
function formEvent(t, responseId) {
  const answers = [['氏名', t.name], ['会社名', t.company], ['メールアドレス', t.email || 'customer@example.com'], ['問い合わせ件名', t.subject], ['問い合わせ内容', t.body]];
  if (t.deadline) answers.push(['希望対応期限', t.deadline]);
  const id = responseId || ('R' + (++responseSeq));
  return { response: {
    getId: () => id,
    getTimestamp: () => new Date(),
    getItemResponses: () => answers.filter((a) => a[1]).map((a) => ({ getItem: () => ({ getTitle: () => a[0] }), getResponse: () => a[1] })),
  } };
}
function rowObj(env, row) {
  const s = env.sheets['案件管理'];
  const headers = s.data[0];
  const o = {};
  headers.forEach((h, i) => { const v = s.cell(row, i + 1); o[h] = v === undefined ? '' : v; });
  return o;
}
function lastRow(env) { return env.sheets['案件管理'].getLastRow(); }
function decodeDraft(raw) {
  const mime = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  const [head, body] = mime.split('\r\n\r\n');
  const subjB64 = head.match(/Subject: =\?UTF-8\?B\?(.+)\?=/)[1];
  return {
    head,
    to: head.match(/^To: (.+)$/m)[1],
    subject: Buffer.from(subjB64, 'base64').toString('utf8'),
    body: Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8'),
  };
}
const sample = { name: '青山 健一', company: '青山商事株式会社（架空）', email: 'test01@example.com', subject: '事務所エアコン交換の見積もり', body: 'エアコン3台の交換見積もりをお願いします。' };
function setup() { const env = createEnv(); env.ctx.setupFlowPilot(); return env; }

// ---------------- テスト本体 ----------------
const results = [];
function test(name, fn) {
  try { fn(); results.push([true, name]); } catch (e) { results.push([false, name, e.message]); }
}

test('初期セットアップ: 4つのシート・設定・タスクリスト・フォーム・トリガーが作成される', () => {
  const env = setup();
  ['案件管理', 'ダッシュボード', '処理ログ', '設定'].forEach((n) => assert.ok(env.sheets[n], n + ' がない'));
  assert.deepStrictEqual([...env.sheets['案件管理'].data[0]], [...env.ctx.__fp.CASE_HEADERS]);
  assert.strictEqual(env.props.TASKLIST_ID, 'LIST1');
  assert.strictEqual(env.props.FORM_ID, 'FORM1');
  assert.deepStrictEqual([...env.triggers], ['onFormSubmitHandler', 'autoRecover']);
  assert.ok(env.sheets['設定'].getLastRow() >= 9, '設定の初期値が入っていない');
});

test('初期セットアップを2回実行しても、トリガー・設定・見出しが重複しない', () => {
  const env = setup();
  const settingsRows = env.sheets['設定'].getLastRow();
  env.ctx.setupFlowPilot();
  assert.deepStrictEqual([...env.triggers], ['onFormSubmitHandler', 'autoRecover']);
  assert.strictEqual(env.sheets['設定'].getLastRow(), settingsRows);
  assert.strictEqual(env.sheets['案件管理'].getLastColumn(), env.ctx.__fp.CASE_HEADERS.length);
});

test('通常の問い合わせ: 受付→AI分析→タスク→下書き まで完了する', () => {
  const env = setup();
  env.ctx.onFormSubmitHandler(formEvent(sample));
  const c = rowObj(env, 2);
  assert.match(String(c['受付ID']), /^FP-\d{8}-0001$/);
  assert.strictEqual(c['AI分類'], '見積依頼');
  assert.strictEqual(c['対応状況'], '未対応');
  assert.strictEqual(c['AI処理状況'], '完了', '注意: ' + c['注意・エラー内容']);
  assert.strictEqual(c['問い合わせ原文'], sample.body);
  assert.strictEqual(env.tasks.length, 1);
  assert.strictEqual(env.drafts.length, 1);
  assert.strictEqual(c['TasksタスクID'], env.tasks[0].id);
  assert.strictEqual(c['Gmail下書きID'], env.drafts[0].id);
  assert.strictEqual(env.tasks[0].title, '【見積依頼】青山商事株式会社（架空）への問い合わせ対応');
  assert.ok(env.tasks[0].notes.includes('受付ID: ' + c['受付ID']));
  assert.strictEqual(env.tasks[0].due, undefined, '期限が無いのにタスク期限が設定された');
});

test('OpenAIへのリクエスト: JSONスキーマ指定・APIキーはヘッダーのみ・本文はデータとして渡す', () => {
  const env = setup();
  env.ctx.onFormSubmitHandler(formEvent(sample));
  const req = env.openAiRequests[0];
  assert.strictEqual(req.url, 'https://api.openai.com/v1/responses');
  assert.strictEqual(req.headers.Authorization, 'Bearer ' + FAKE_KEY);
  assert.strictEqual(req.body.text.format.type, 'json_schema');
  assert.strictEqual(req.body.text.format.strict, true);
  assert.deepStrictEqual(req.body.text.format.schema.properties.category.enum, ['見積依頼', '日程調整', 'サービス相談', 'その他']);
  assert.ok(req.body.input[0].content.includes('絶対に従わず'));
  assert.ok(req.body.input[1].content.includes('<inquiry>'));
});

test('APIキーがソースコード・シート・ログに出力されない', () => {
  const env = setup();
  env.mode.openAi = 'badKey';
  env.ctx.onFormSubmitHandler(formEvent(sample));
  const all = JSON.stringify(Object.values(env.sheets).map((s) => s.data));
  assert.ok(!all.includes(FAKE_KEY), 'シートにAPIキーが書かれた');
  assert.ok(!/sk-[A-Za-z0-9]{10,}/.test(env.sources), 'ソースコードにAPIキーらしき文字列がある');
});

test('メール送信のコードが存在せず、送信APIも呼ばれない', () => {
  const env = setup();
  ['通常', '異常'].forEach(() => env.ctx.onFormSubmitHandler(formEvent(sample)));
  assert.strictEqual(env.sendCalls, 0);
  assert.ok(!/\.send\s*\(|sendEmail|GmailApp|MailApp/.test(env.sources.replace(/r\.submit\(\)/g, '')), 'ソースに送信処理がある');
});

test('Gmail下書き: 宛先・件名（受付ID付き）・本文・署名が正しい', () => {
  const env = setup();
  env.ctx.onFormSubmitHandler(formEvent(sample));
  const d = decodeDraft(env.drafts[0].raw);
  const c = rowObj(env, 2);
  assert.strictEqual(d.to, 'test01@example.com');
  assert.strictEqual(d.subject, 'Re: 事務所エアコン交換の見積もり [' + c['受付ID'] + ']');
  assert.ok(d.body.includes('青山 健一様'));
  assert.ok(d.body.includes('株式会社みなと設備工業（架空）'), '署名がない');
});

test('重複防止: 同じフォーム回答が2回届いても、案件・タスク・下書きは1つだけ', () => {
  const env = setup();
  env.ctx.onFormSubmitHandler(formEvent(sample, 'SAME'));
  env.ctx.onFormSubmitHandler(formEvent(sample, 'SAME'));
  assert.strictEqual(lastRow(env), 2);
  assert.strictEqual(env.tasks.length, 1);
  assert.strictEqual(env.drafts.length, 1);
});

test('重複防止: 完了済みの案件を再処理しても何も作られない', () => {
  const env = setup();
  env.ctx.onFormSubmitHandler(formEvent(sample));
  env.ctx.retryPendingCases();
  env.ctx.processCase_(2);
  assert.strictEqual(env.tasks.length, 1);
  assert.strictEqual(env.drafts.length, 1);
  assert.strictEqual(env.openAiCalls, 1);
});

test('重複防止: 「処理中」の案件は別の処理から二重に処理されない', () => {
  const env = setup();
  env.ctx.onFormSubmitHandler(formEvent(sample));
  env.ctx.writeFields_(env.ctx.getSheet_('案件管理'), 2, { 'AI処理状況': '処理中', '最終更新日時': env.ctx.nowText_(), 'TasksタスクID': '', '要約': '' });
  assert.strictEqual(env.ctx.processCase_(2), null);
  assert.strictEqual(env.tasks.length, 1);
});

test('OpenAI障害: 一時的な500エラーは自動で再試行して成功する', () => {
  const env = setup();
  env.mode.openAiFailCount = 2;
  env.ctx.onFormSubmitHandler(formEvent(sample));
  assert.strictEqual(rowObj(env, 2)['AI処理状況'], '完了');
  assert.strictEqual(env.openAiCalls, 3);
});

test('OpenAI障害: 失敗しても問い合わせ原文は残り、エラー記録→手動再処理で完了する', () => {
  const env = setup();
  env.mode.openAiFailCount = 10;
  env.ctx.onFormSubmitHandler(formEvent(sample));
  let c = rowObj(env, 2);
  assert.strictEqual(c['AI処理状況'], 'エラー');
  assert.strictEqual(c['問い合わせ原文'], sample.body);
  assert.strictEqual(c['再試行回数'], 1);
  assert.match(String(c['注意・エラー内容']), /HTTP 500/);
  assert.strictEqual(env.tasks.length, 0);
  assert.ok(env.sheets['処理ログ'].data.some((r) => r[1] === 'ERROR'));
  env.mode.openAiFailCount = 0;
  env.ctx.retryPendingCases();
  c = rowObj(env, 2);
  assert.strictEqual(c['AI処理状況'], '完了');
  assert.strictEqual(env.tasks.length, 1);
  assert.strictEqual(env.drafts.length, 1);
});

test('AI出力がJSONでない場合はエラーとして記録される', () => {
  const env = setup();
  env.mode.openAi = 'notJson';
  env.ctx.onFormSubmitHandler(formEvent(sample));
  assert.strictEqual(rowObj(env, 2)['AI処理状況'], 'エラー');
});

test('Tasks障害（作成されていない）: エラー記録→再処理でタスクは1つだけ', () => {
  const env = setup();
  env.mode.task = 'fail';
  env.ctx.onFormSubmitHandler(formEvent(sample));
  let c = rowObj(env, 2);
  assert.strictEqual(c['AI処理状況'], 'エラー');
  assert.strictEqual(c['TasksタスクID'], '');
  assert.strictEqual(env.drafts.length, 1, 'Tasksが失敗しても下書きは作成されるべき');
  env.ctx.retryPendingCases();
  c = rowObj(env, 2);
  assert.strictEqual(c['AI処理状況'], '完了');
  assert.strictEqual(env.tasks.length, 1);
  assert.strictEqual(env.drafts.length, 1);
  assert.strictEqual(env.openAiCalls, 1, '再処理でAIを再度呼ぶべきではない');
});

test('Tasks障害（実は作成済み）: 受付IDで既存タスクを見つけ、重複作成しない', () => {
  const env = setup();
  env.mode.task = 'failAfterCreate';
  env.ctx.onFormSubmitHandler(formEvent(sample));
  const c = rowObj(env, 2);
  assert.strictEqual(env.tasks.length, 1);
  assert.strictEqual(c['TasksタスクID'], env.tasks[0].id);
  assert.strictEqual(c['AI処理状況'], '完了');
});

test('処理が途中で止まった（「作成中」が残った）場合も重複作成しない', () => {
  const env = setup();
  env.ctx.onFormSubmitHandler(formEvent(sample));
  const sheet = env.ctx.getSheet_('案件管理');
  // タスク作成直後にIDを記録する前に止まった状況を再現
  env.ctx.writeFields_(sheet, 2, { 'TasksタスクID': '作成中', 'AI処理状況': 'エラー' });
  env.ctx.retryPendingCases();
  assert.strictEqual(env.tasks.length, 1);
  assert.strictEqual(rowObj(env, 2)['TasksタスクID'], env.tasks[0].id);
});

test('Gmail障害（作成されたか不明・検索にも出ない）: 要確認にし、再処理しても作り直さない', () => {
  const env = setup();
  env.mode.draft = 'failAfterCreate';
  env.mode.draftSearchIndexed = false;
  env.ctx.onFormSubmitHandler(formEvent(sample));
  let c = rowObj(env, 2);
  assert.strictEqual(c['AI処理状況'], '要確認');
  assert.strictEqual(c['Gmail下書きID'], '作成中');
  assert.match(String(c['注意・エラー内容']), /下書きが作成されたか確認できません/);
  env.ctx.retryPendingCases(); // 要確認は自動の再処理対象外
  env.sheets['案件管理'].activeRow = 2;
  env.ctx.retrySelectedRow(); // 人が選んで再処理しても、作成中のままなら作らない
  assert.strictEqual(env.drafts.length, 1);
  // 人がGmailを確認 → 検索で見つかるようになれば、そのIDを記録して完了
  env.mode.draftSearchIndexed = true;
  env.ctx.retrySelectedRow();
  c = rowObj(env, 2);
  assert.strictEqual(c['Gmail下書きID'], env.drafts[0].id);
  assert.strictEqual(c['AI処理状況'], '完了');
  assert.strictEqual(env.drafts.length, 1);
});

test('Gmail障害（作成されていない）: 人がセルを空にして再処理すると1つだけ作成', () => {
  const env = setup();
  env.mode.draft = 'fail';
  env.ctx.onFormSubmitHandler(formEvent(sample));
  assert.strictEqual(rowObj(env, 2)['AI処理状況'], '要確認');
  assert.strictEqual(env.drafts.length, 0);
  env.ctx.writeFields_(env.ctx.getSheet_('案件管理'), 2, { 'Gmail下書きID': '' }); // 人が確認してセルを空にした
  env.sheets['案件管理'].activeRow = 2;
  env.ctx.retrySelectedRow();
  assert.strictEqual(env.drafts.length, 1);
  assert.strictEqual(rowObj(env, 2)['AI処理状況'], '完了');
});

test('期限: 原文に日付がある場合だけ採用し、タスクに期限を設定する', () => {
  const env = setup();
  env.ctx.onFormSubmitHandler(formEvent({ ...sample, body: '照明交換の見積書を12月10日までにお願いします。' }));
  const c = rowObj(env, 2);
  assert.strictEqual(env.ctx.normalizeDate_(c['希望期限']), '2026-12-10');
  assert.strictEqual(env.tasks[0].due, '2026-12-10T00:00:00.000Z');
});

test('期限: フォームの希望対応期限が最優先で使われる', () => {
  const env = setup();
  env.ctx.onFormSubmitHandler(formEvent({ ...sample, deadline: '2026-11-30' }));
  assert.strictEqual(env.tasks[0].due, '2026-11-30T00:00:00.000Z');
});

test('期限: AIが原文に無い期限を作っても採用しない（ハルシネーション対策）', () => {
  const env = setup();
  env.mode.openAi = 'hallucinateDeadline';
  env.ctx.onFormSubmitHandler(formEvent(sample));
  const c = rowObj(env, 2);
  assert.strictEqual(c['希望期限'], '');
  assert.strictEqual(env.tasks[0].due, undefined);
  assert.match(String(c['注意・エラー内容']), /採用しませんでした/);
});

test('期限: 「来週の金曜日」のような日付が明記されていない表現からは期限を設定しない', () => {
  const env = setup();
  env.mode.openAi = 'relativeDeadline';
  env.ctx.onFormSubmitHandler(formEvent({ ...sample, body: '見積もりを来週の金曜日までにいただけますか。' }));
  assert.strictEqual(rowObj(env, 2)['希望期限'], '');
  assert.strictEqual(env.tasks[0].due, undefined);
});

test('金額・日付: 原文に無い金額や日付を返信文に書いたら「要確認」にする', () => {
  const env = setup();
  env.mode.openAi = 'hallucinateAmount';
  env.ctx.onFormSubmitHandler(formEvent(sample));
  const c = rowObj(env, 2);
  assert.strictEqual(c['AI処理状況'], '要確認');
  assert.match(String(c['注意・エラー内容']), /金額表現.*300000/);
  assert.match(String(c['注意・エラー内容']), /日付.*11-25/);
});

test('金額: 原文にある金額（予算50万円）を返信文で使うのは問題なし', () => {
  const env = setup();
  const r = env.ctx.validateAnalysis_(
    { category: '見積依頼', summary: '予算50万円以内でトイレ改修', priority: '通常', required_actions: '見積作成', task_action: '見積対応', deadline: '', deadline_evidence: '', missing_info: [], reply_body: 'ご予算500,000円以内とのこと承知しました。', injection_suspected: false },
    { '件名': 'トイレ改修', '問い合わせ原文': '予算は50万円以内を希望しています。', '会社名': '', '氏名': 'テスト' },
    env.ctx.getSettings_());
  assert.strictEqual(r.needsReview, false, JSON.stringify(r.warnings));
});

test('分類: 設定に無い分類をAIが返したら「その他」にして要確認', () => {
  const env = setup();
  env.mode.openAi = 'badCategory';
  env.ctx.onFormSubmitHandler(formEvent(sample));
  const c = rowObj(env, 2);
  assert.strictEqual(c['AI分類'], 'その他');
  assert.strictEqual(c['AI処理状況'], '要確認');
});

test('プロンプトインジェクション: 本文に命令文があれば「要確認」にする', () => {
  const env = setup();
  const t = env.ctx.__fp.TEST_CASES.find((x) => x.no === 24);
  env.ctx.onFormSubmitHandler(formEvent({ ...t, email: 'test24@example.com' }));
  const c = rowObj(env, 2);
  assert.strictEqual(c['AI処理状況'], '要確認');
  assert.match(String(c['注意・エラー内容']), /指示とみられる文/);
});

test('数式インジェクション: 「=」で始まる入力が数式として実行されず文字のまま保存される', () => {
  const env = setup();
  const t = env.ctx.__fp.TEST_CASES.find((x) => x.no === 25);
  env.ctx.onFormSubmitHandler(formEvent({ ...t, email: 'test25@example.com' }));
  const c = rowObj(env, 2);
  assert.strictEqual(c['氏名'], t.name);
  assert.strictEqual(c['会社名'], t.company);
  assert.strictEqual(c['件名'], t.subject);
  const all = JSON.stringify(env.sheets['案件管理'].data);
  assert.ok(!all.includes('#FORMULA'), '数式として解釈された値がある');
});

test('メールヘッダーインジェクション: 改行を含む不正な宛先では下書きを作らない', () => {
  const env = setup();
  env.ctx.onFormSubmitHandler(formEvent({ ...sample, email: 'a@example.com\r\nBcc: victim@example.com' }));
  const c = rowObj(env, 2);
  assert.strictEqual(env.drafts.length, 0);
  assert.strictEqual(c['AI処理状況'], 'エラー');
  assert.match(String(c['注意・エラー内容']), /メールアドレスの形式/);
});

test('長文: 4000文字を超える本文はAIに渡す前に切り詰める（原文はシートに全文保存）', () => {
  const env = setup();
  const t = env.ctx.__fp.TEST_CASES.find((x) => x.no === 28);
  env.ctx.onFormSubmitHandler(formEvent({ ...t, email: 'test28@example.com' }));
  const sent = JSON.parse(env.openAiRequests[0].body.input[1].content.split('<inquiry>')[1].split('</inquiry>')[0]);
  assert.ok(sent['問い合わせ内容'].length <= 4000);
  assert.strictEqual(rowObj(env, 2)['問い合わせ原文'], t.body);
});

test('設定変更: 分類を設定シートで変えると、AIへの選択肢も変わる（業種に合わせて変更可能）', () => {
  const env = setup();
  const s = env.sheets['設定'];
  const row = s.data.findIndex((r) => r[0] === '問い合わせ分類') + 1;
  s.set(row, 2, '入居申込：部屋を借りたい\n内見予約：内見したい');
  const cats = env.ctx.getSettings_().categories.map((c) => c.name);
  assert.deepStrictEqual([...cats], ['入居申込', '内見予約', 'その他']);
});

test('全テストデータ40件: すべてエラーなく処理され、受付IDが重複しない', () => {
  const env = setup();
  const cases = env.ctx.__fp.TEST_CASES;
  cases.forEach((t) => env.ctx.onFormSubmitHandler(formEvent({ ...t, email: 'test' + ('0' + t.no).slice(-2) + '@example.com' })));
  assert.strictEqual(lastRow(env), cases.length + 1);
  const ids = new Set();
  for (let r = 2; r <= lastRow(env); r++) {
    const c = rowObj(env, r);
    assert.notStrictEqual(c['AI処理状況'], 'エラー', c['受付ID'] + ': ' + c['注意・エラー内容']);
    ids.add(c['受付ID']);
  }
  assert.strictEqual(ids.size, cases.length);
  assert.strictEqual(env.tasks.length, cases.length);
  assert.strictEqual(env.drafts.length, cases.length);
  assert.ok(cases.length >= 30, 'テストデータが30件未満');
  assert.ok(cases.filter((t) => t.kind === '通常').length >= 20, '通常ケースが20件未満');
  // 評価機能が動くこと（模擬AIなので精度の数値自体には意味がない）
  env.ctx.evaluateTestResults();
  const evalRows = env.sheets['テスト評価'].data;
  assert.ok(evalRows.some((r) => String(r[1]).includes(' / 40 = ')), '分類精度の行が無い');
  assert.ok(evalRows.some((r) => String(r[0]).startsWith('AIが未処理') && r[1] === 0), '未処理件数が0でない');
  assert.ok(evalRows.some((r) => String(r[0]).startsWith('うち初見テスト') && String(r[1]).includes(' / 8 = ')), '初見テストの精度行が無い');
});

test('ダッシュボード: 集計用の数式が正しい列を参照している', () => {
  const env = setup();
  const f = env.sheets['ダッシュボード'];
  const formulaOf = (label) => { const r = f.data.findIndex((row) => row[0] === label) + 1; return f.cell(r, 2); };
  assert.strictEqual(formulaOf('未対応'), "#FORMULA:=COUNTIF('案件管理'!Q2:Q,\"未対応\")");
  assert.strictEqual(formulaOf('エラー'), "#FORMULA:=COUNTIF('案件管理'!R2:R,\"エラー\")");
  assert.ok(f.formulas['5,4'].startsWith("=IFERROR(FILTER({'案件管理'!A2:A"));
});

test('混雑で受付の保存に失敗しても、エラーをログに残し、自動復旧でフォームから取り込む', () => {
  const env = setup();
  const ev = formEvent(sample);
  env.formResponses.push(ev.response); // 回答はフォーム側には保存されている
  env.lockAvailable = false;            // 順番待ちがタイムアウトする状況
  env.ctx.onFormSubmitHandler(ev);
  assert.strictEqual(lastRow(env), 1, '案件管理には保存されていないはず');
  assert.ok(env.sheets['処理ログ'].data.some((r) => r[1] === 'ERROR' && String(r[4]).includes('自動復旧')), 'エラーがログに無い');
  env.lockAvailable = true;
  env.ctx.autoRecover();                // 10分ごとの自動復旧
  const c = rowObj(env, 2);
  assert.strictEqual(c['フォーム回答ID'], ev.response.getId());
  assert.strictEqual(c['AI処理状況'], '完了');
  assert.strictEqual(env.tasks.length, 1);
  env.ctx.autoRecover();                // もう一度動いても重複しない
  assert.strictEqual(lastRow(env), 2);
  assert.strictEqual(env.tasks.length, 1);
});

test('混雑で処理開始に失敗した案件（受付済のまま）も自動復旧で処理される', () => {
  const env = setup();
  const ev = formEvent(sample);
  env.formResponses.push(ev.response);
  env.ctx.registerInquiry_(env.ctx.extractInquiryFromFormEvent_(ev));
  env.lockAvailable = false;
  assert.strictEqual(env.ctx.processCase_(2), null);
  assert.strictEqual(rowObj(env, 2)['AI処理状況'], '受付済');
  env.lockAvailable = true;
  env.ctx.autoRecover();
  assert.strictEqual(rowObj(env, 2)['AI処理状況'], '完了');
});

test('自動復旧は、エラーの案件を3回までしか自動で再試行しない（API料金の無駄を防ぐ）', () => {
  const env = setup();
  env.mode.openAiFailCount = 1000;
  env.ctx.onFormSubmitHandler(formEvent(sample));
  for (let i = 0; i < 5; i++) env.ctx.autoRecover();
  assert.strictEqual(rowObj(env, 2)['再試行回数'], 3);
  env.ctx.retryPendingCases();          // 手動の再処理なら回数に関係なく実行できる
  assert.strictEqual(rowObj(env, 2)['再試行回数'], 4);
});

test('日付だけの値（期限）は文字として保存され、日付がずれない', () => {
  const env = setup();
  env.ctx.onFormSubmitHandler(formEvent({ ...sample, deadline: '2026-11-30' }));
  const c = rowObj(env, 2);
  assert.strictEqual(c['フォーム希望期限'], '2026-11-30');
  assert.strictEqual(c['希望期限'], '2026-11-30');
});

test('分類設定の「※」行は分類にならず、AIへの補足ルールとして渡される', () => {
  const env = setup();
  const s = env.ctx.getSettings_();
  assert.strictEqual(s.categories.map((c) => c.name).join(','), '見積依頼,日程調整,サービス相談,その他');
  env.ctx.onFormSubmitHandler(formEvent(sample));
  assert.ok(env.openAiRequests[0].body.input[0].content.includes('※複数に当てはまる場合は'));
});

test('テスト番号の入力: 「1-3」「5,17,31」「all」を正しく読み取る', () => {
  const env = setup();
  assert.strictEqual(env.ctx.parseTestNumbers_('1-3').join(','), '1,2,3');
  assert.strictEqual(env.ctx.parseTestNumbers_('5,17, 31').join(','), '5,17,31');
  assert.strictEqual(env.ctx.parseTestNumbers_('5、17').join(','), '5,17');
  assert.strictEqual(env.ctx.parseTestNumbers_('all').length, 40);
  assert.strictEqual(env.ctx.parseTestNumbers_('abc'), null);
});

// ---------------- 結果表示 ----------------
let failed = 0;
results.forEach(([ok, name, msg]) => {
  console.log((ok ? '  OK   ' : '  NG   ') + name + (ok ? '' : '\n         → ' + msg));
  if (!ok) failed++;
});
console.log('\n' + (results.length - failed) + ' / ' + results.length + ' 件のテストに合格' + (failed ? '（' + failed + '件 不合格）' : ''));
process.exit(failed ? 1 : 0);
