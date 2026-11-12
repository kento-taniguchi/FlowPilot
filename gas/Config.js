/**
 * Config.js — FlowPilot の定数と「設定」シートの読み込み
 *
 * 企業名・分類・返信トーンなどの業種ごとに変わる情報はここに直接書かず、
 * スプレッドシートの「設定」シートで変更できるようにしています。
 * （ここにある DEFAULT_SETTINGS は、初回セットアップ時に入る「初期値」だけです）
 */

const FP = {
  SHEET_CASES: '案件管理',
  SHEET_DASHBOARD: 'ダッシュボード',
  SHEET_LOG: '処理ログ',
  SHEET_SETTINGS: '設定',
  SHEET_TEST_EVAL: 'テスト評価',

  // スクリプトプロパティのキー（APIキーはここに保存。ソースコードには書かない）
  PROP_OPENAI_KEY: 'OPENAI_API_KEY',
  PROP_FORM_ID: 'FORM_ID',
  PROP_TASKLIST_ID: 'TASKLIST_ID',
  PROP_SEQ: 'RECEIPT_SEQ',

  OPENAI_URL: 'https://api.openai.com/v1/responses',
  MARKER_IN_PROGRESS: '作成中', // Tasks/Gmail を作成している最中の印（重複防止用）
  STALE_MINUTES: 10,            // 「処理中」のまま止まった案件を再処理対象にするまでの分数
  MAX_INPUT_CHARS: 4000,        // AIに渡す問い合わせ本文の最大文字数
  MAX_RUN_MS: 4.5 * 60 * 1000,  // 再処理をまとめて行うときの最大実行時間（Apps Scriptの上限6分より短く）
};

const CASE_STATUS = ['未対応', '対応中', '完了'];

const AI_STATUS = {
  RECEIVED: '受付済',
  PROCESSING: '処理中',
  DONE: '完了',
  REVIEW: '要確認',
  ERROR: 'エラー',
};

const PRIORITIES = ['高', '通常', '要確認'];

/** 案件管理シートの列（この順番でシートが作られます） */
const CASE_HEADERS = [
  '受付ID', '受付日時', '氏名', '会社名', 'メールアドレス', '件名', '問い合わせ原文',
  'フォーム希望期限', 'AI分類', '要約', '優先度', '必要な対応', '希望期限', '不足情報',
  'タスク名', '返信文案',
  '対応状況', 'AI処理状況', 'TasksタスクID', 'Gmail下書きID',
  '注意・エラー内容', '再試行回数', 'AI処理秒数', '確認・対応時間(分)',
  'フォーム回答ID', '最終更新日時',
];

const LOG_HEADERS = ['日時', 'レベル', '受付ID', '処理', '内容'];

/** フォームの質問タイトル（フォーム作成とデータ読み取りの両方で使う） */
const FORM_ITEMS = {
  NAME: '氏名',
  COMPANY: '会社名',
  EMAIL: 'メールアドレス',
  SUBJECT: '問い合わせ件名',
  BODY: '問い合わせ内容',
  DEADLINE: '希望対応期限',
};

/** 設定シートの初期値 [項目, 値, 説明] — すべて架空の会社です */
const DEFAULT_SETTINGS = [
  ['会社名', '株式会社みなと設備工業（架空）', '返信メールなどで使う自社名'],
  ['業種・事業内容', '給排水・空調・電気設備の工事とメンテナンスを行う設備工事会社（架空のデモ企業）', 'AIが問い合わせの文脈を理解するための説明'],
  ['問い合わせ分類',
    '見積依頼：工事・修理・点検などの費用を知りたい、見積書がほしい\n' +
    '日程調整：すでに依頼済み・予定済みの訪問・工事・打合せ・点検の日時を決めたい、変更・キャンセルしたい（新しい故障・トラブルの依頼は含まない）\n' +
    'サービス相談：故障・水漏れ・つまりなどのトラブル対応や修理の依頼（「すぐ来てほしい」を含む）、対応可否、工事内容、製品選びなどの相談\n' +
    'その他：上記以外（営業・売り込み、求人応募、請求書の送付先確認など）\n' +
    '※複数に当てはまる場合は、お客様の主な目的で1つ選ぶ',
    '1行に「分類名：説明」の形で書く。「※」で始まる行は分類ではなく補足ルール。「その他」は必ず残してください'],
  ['高優先度の基準', '水漏れ・漏電・ガス臭・設備停止など、安全や営業に影響する緊急事態。または対応期限が受付日から3日以内のもの。', 'AIが優先度「高」を判断する基準'],
  ['返信のトーン', '丁寧で落ち着いたビジネス敬語。専門用語はなるべく避け、お客様に分かりやすく書く。', '返信メール文案の書き方'],
  ['返信署名', '――――――――――――\n株式会社みなと設備工業（架空）\nお客様窓口\nTEL：000-0000-0000（架空）\nMail：info@example.com', '返信メールの最後に自動で付く署名'],
  ['OpenAIモデル', 'gpt-6.1-terra', '使用するOpenAIのモデル名（安くしたい場合は gpt-6-luna）'],
  ['手作業の想定時間(分)', '15', '従来、問い合わせ1件を手作業で処理していた平均時間（実測して入力）'],
];

/**
 * 設定シートを読み込み、{ 項目名: 値 } のオブジェクトで返す。
 * シートに無い項目は初期値で補う。
 */
function getSettings_() {
  const settings = {};
  DEFAULT_SETTINGS.forEach(function (row) { settings[row[0]] = row[1]; });
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(FP.SHEET_SETTINGS);
  if (sheet && sheet.getLastRow() >= 2) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues().forEach(function (r) {
      const key = String(r[0]).trim();
      if (key && String(r[1]).trim() !== '') settings[key] = String(r[1]).trim();
    });
  }
  settings.categories = parseCategories_(settings['問い合わせ分類']);
  settings.categoryNotes = String(settings['問い合わせ分類'] || '').split(/\r?\n/)
    .map(function (l) { return l.trim(); })
    .filter(function (l) { return /^[※*]/.test(l); });
  return settings;
}

/** 「分類名：説明」の複数行テキストを [{name, description}] に変換する */
function parseCategories_(text) {
  const list = [];
  String(text || '').split(/\r?\n/).forEach(function (line) {
    const t = line.trim();
    if (!t || /^[※*]/.test(t)) return; // 「※」で始まる行は補足ルール（分類ではない）
    const m = t.match(/^([^:：]+)[:：]\s*(.*)$/);
    const name = (m ? m[1] : t).trim();
    const description = m ? m[2].trim() : '';
    if (name && !list.some(function (c) { return c.name === name; })) {
      list.push({ name: name, description: description });
    }
  });
  if (!list.some(function (c) { return c.name === 'その他'; })) {
    list.push({ name: 'その他', description: '上記のどれにも当てはまらないもの' });
  }
  return list;
}

/** スクリプトプロパティから OpenAI APIキーを取得する（無ければ分かりやすいエラー） */
function getOpenAiKey_() {
  const key = PropertiesService.getScriptProperties().getProperty(FP.PROP_OPENAI_KEY);
  if (!key) {
    throw new Error('OpenAI APIキーが未設定です。Apps Script の「プロジェクトの設定」→「スクリプト プロパティ」に OPENAI_API_KEY を追加してください。');
  }
  return key;
}
