/**
 * Setup.js — 初期セットアップ（何度実行しても安全）
 *
 * メニュー「FlowPilot」→「初期セットアップ」で次を自動で行います。
 *   1. 案件管理・ダッシュボード・処理ログ・設定 シートを作成（既存データは消さない）
 *   2. Google Tasks に「FlowPilot 問い合わせ対応」リストを作成
 *   3. 問い合わせ用の Google フォームを作成
 *   4. フォーム送信時に自動処理するトリガーを作成
 */

function setupFlowPilot() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const props = PropertiesService.getScriptProperties();
  const messages = [];

  // 1) シート（日時のずれを防ぐため、スプレッドシートのタイムゾーンをスクリプトと揃える）
  ss.setSpreadsheetTimeZone(Session.getScriptTimeZone());
  setupCasesSheet_(ss);
  setupSimpleSheet_(ss, FP.SHEET_LOG, LOG_HEADERS, [150, 70, 150, 100, 600]);
  setupSettingsSheet_(ss);
  buildDashboard_(ss);
  messages.push('シート（案件管理・ダッシュボード・処理ログ・設定）を準備しました');

  // 2) Google Tasks のリスト
  let taskListId = props.getProperty(FP.PROP_TASKLIST_ID);
  if (taskListId) {
    try { Tasks.Tasklists.get(taskListId); } catch (e) { taskListId = ''; }
  }
  if (!taskListId) {
    taskListId = Tasks.Tasklists.insert({ title: 'FlowPilot 問い合わせ対応' }).id;
    props.setProperty(FP.PROP_TASKLIST_ID, taskListId);
    messages.push('Google Tasks に「FlowPilot 問い合わせ対応」リストを作成しました');
  }

  // 3) Google フォーム
  let form = null;
  const formId = props.getProperty(FP.PROP_FORM_ID);
  if (formId) {
    try { form = FormApp.openById(formId); } catch (e) { form = null; }
  }
  if (!form) {
    form = createInquiryForm_();
    props.setProperty(FP.PROP_FORM_ID, form.getId());
    messages.push('問い合わせフォームを作成しました');
  }

  // 4) トリガー（重複しないよう、既存のものを消してから1つだけ作る）
  ScriptApp.getProjectTriggers().forEach(function (t) {
    const h = t.getHandlerFunction();
    if (h === 'onFormSubmitHandler' || h === 'autoRecover') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('onFormSubmitHandler').forForm(form).onFormSubmit().create();
  ScriptApp.newTrigger('autoRecover').timeBased().everyMinutes(10).create();
  messages.push('フォーム送信時の自動処理と、10分ごとの自動復旧（取り込み漏れ・停止した処理の再実行）を設定しました');

  const hasKey = !!props.getProperty(FP.PROP_OPENAI_KEY);
  appendLog_('INFO', '', 'セットアップ', messages.join(' / '));
  showMessage_(
    'FlowPilot の初期セットアップが完了しました。\n\n・' + messages.join('\n・') +
    '\n\n■ 回答用フォームURL（お客様が入力する画面）\n' + form.getPublishedUrl() +
    '\n\n■ フォームの編集URL\n' + form.getEditUrl() +
    (hasKey ? '\n\nOpenAI APIキー: 設定済み' : '\n\n⚠ OpenAI APIキーが未設定です。手順書に従ってスクリプトプロパティに OPENAI_API_KEY を追加してください。')
  );
}

function setupCasesSheet_(ss) {
  let sheet = ss.getSheetByName(FP.SHEET_CASES);
  if (!sheet) sheet = ss.insertSheet(FP.SHEET_CASES, 0);
  ensureHeaders_(sheet, CASE_HEADERS);
  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(1);

  const map = getHeaderMap_(sheet);
  const widths = { '受付ID': 150, '受付日時': 140, '件名': 200, '問い合わせ原文': 260, '要約': 260, '必要な対応': 220,
    '不足情報': 180, 'タスク名': 220, '返信文案': 260, '注意・エラー内容': 260, 'AI分類': 100, '優先度': 70,
    '対応状況': 80, 'AI処理状況': 90 };
  Object.keys(widths).forEach(function (h) { sheet.setColumnWidth(map[h], widths[h]); });

  const maxRows = sheet.getMaxRows();
  // 長い文章の列は折り返さず、行の高さを揃える
  sheet.getRange(2, 1, maxRows - 1, sheet.getLastColumn()).setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP).setVerticalAlignment('top');

  // 対応状況はプルダウンで「未対応・対応中・完了」から選ぶ
  const statusRule = SpreadsheetApp.newDataValidation().requireValueInList(CASE_STATUS, true).setAllowInvalid(false).build();
  sheet.getRange(2, map['対応状況'], maxRows - 1, 1).setDataValidation(statusRule);

  // 色分け（条件付き書式）
  const col = function (h) { return sheet.getRange(2, map[h], maxRows - 1, 1); };
  const rules = [
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('高').setBackground('#f4c7c3').setFontColor('#a50e0e').setRanges([col('優先度')]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('要確認').setBackground('#fce8b2').setRanges([col('優先度')]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(AI_STATUS.ERROR).setBackground('#f4c7c3').setFontColor('#a50e0e').setRanges([col('AI処理状況')]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(AI_STATUS.REVIEW).setBackground('#fce8b2').setRanges([col('AI処理状況')]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(AI_STATUS.DONE).setFontColor('#137333').setRanges([col('AI処理状況')]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('完了').setFontColor('#80868b').setRanges([col('対応状況')]).build(),
  ];
  sheet.setConditionalFormatRules(rules);
  // 「確認・対応時間(分)」は担当者が手入力する列なので色を付けて目立たせる
  col('確認・対応時間(分)').setBackground('#e8f0fe');
  sheet.getRange(1, map['確認・対応時間(分)']).setNote('担当者が、この案件の確認・修正・送信にかかった時間（分）を入力します。ダッシュボードで削減時間の計算に使います。');
  sheet.getRange(1, map['対応状況']).setNote('担当者がプルダウンで変更します（未対応・対応中・完了）。');
}

function setupSimpleSheet_(ss, name, headers, widths) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  ensureHeaders_(sheet, headers);
  sheet.setFrozenRows(1);
  widths.forEach(function (w, i) { sheet.setColumnWidth(i + 1, w); });
  return sheet;
}

/** 見出し行を作る。既にある見出しはそのまま、足りない見出しだけ右端に追加する */
function ensureHeaders_(sheet, headers) {
  const lastCol = sheet.getLastColumn();
  const existing = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String) : [];
  const missing = headers.filter(function (h) { return existing.indexOf(h) < 0; });
  if (missing.length) {
    const start = existing.filter(String).length ? lastCol + 1 : 1;
    sheet.getRange(1, start, 1, missing.length).setValues([missing]);
  }
  sheet.getRange(1, 1, 1, sheet.getLastColumn()).setFontWeight('bold').setBackground('#1a73e8').setFontColor('#ffffff');
}

function setupSettingsSheet_(ss) {
  const sheet = setupSimpleSheet_(ss, FP.SHEET_SETTINGS, ['項目', '値', '説明'], [180, 480, 380]);
  const existingKeys = sheet.getLastRow() >= 2
    ? sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues().map(function (r) { return String(r[0]); })
    : [];
  const toAdd = DEFAULT_SETTINGS.filter(function (r) { return existingKeys.indexOf(r[0]) < 0; });
  if (toAdd.length) sheet.getRange(sheet.getLastRow() + 1, 1, toAdd.length, 3).setValues(toAdd);
  sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).setWrapStrategy(SpreadsheetApp.WrapStrategy.WRAP).setVerticalAlignment('top');
}

/** ダッシュボード（数式で自動集計。データが増えると自動で更新される） */
function buildDashboard_(ss) {
  let sheet = ss.getSheetByName(FP.SHEET_DASHBOARD);
  if (!sheet) sheet = ss.insertSheet(FP.SHEET_DASHBOARD, 1);
  sheet.clear();
  const cases = ss.getSheetByName(FP.SHEET_CASES);
  const map = getHeaderMap_(cases);
  const R = function (h) { // 例: '案件管理'!Q2:Q
    const letter = columnLetter_(map[h]);
    return "'" + FP.SHEET_CASES + "'!" + letter + '2:' + letter;
  };
  const settingRef = "IFERROR(VALUE(VLOOKUP(\"手作業の想定時間(分)\",'" + FP.SHEET_SETTINGS + "'!A:B,2,FALSE)),0)";

  const rows = [
    ['FlowPilot ダッシュボード', ''],
    ['', ''],
    ['■ 対応状況', '件数'],
    ['問い合わせ総数', '=COUNTA(' + R('受付ID') + ')'],
    ['未対応', '=COUNTIF(' + R('対応状況') + ',"未対応")'],
    ['対応中', '=COUNTIF(' + R('対応状況') + ',"対応中")'],
    ['完了', '=COUNTIF(' + R('対応状況') + ',"完了")'],
    ['高優先度（未完了）', '=COUNTIFS(' + R('優先度') + ',"高",' + R('対応状況') + ',"<>完了")'],
    ['', ''],
    ['■ AI処理状況', '件数'],
    ['完了', '=COUNTIF(' + R('AI処理状況') + ',"完了")'],
    ['要確認', '=COUNTIF(' + R('AI処理状況') + ',"要確認")'],
    ['エラー', '=COUNTIF(' + R('AI処理状況') + ',"エラー")'],
    ['処理中・受付済', '=COUNTIF(' + R('AI処理状況') + ',"処理中")+COUNTIF(' + R('AI処理状況') + ',"受付済")'],
    ['', ''],
    ['■ 作業時間の削減効果', ''],
    ['手作業の想定時間（分/件）', '=' + settingRef],
    ['FlowPilot利用時の平均確認時間（分/件）', '=IFERROR(AVERAGE(' + R('確認・対応時間(分)') + '),"未入力")'],
    ['1件あたりの削減時間（分）', '=IFERROR(B17-B18,"-")'],
    ['削減率', '=IFERROR((B17-B18)/B17,"-")'],
    ['確認時間を入力した件数', '=COUNT(' + R('確認・対応時間(分)') + ')'],
    ['削減時間の合計（分）', '=IFERROR(B19*B21,"-")'],
  ];
  sheet.getRange(1, 1, rows.length, 2).setValues(rows);
  sheet.getRange('A1').setFontSize(16).setFontWeight('bold');
  [3, 10, 16].forEach(function (r) { sheet.getRange(r, 1, 1, 2).setFontWeight('bold').setBackground('#e8f0fe'); });
  sheet.getRange('B20').setNumberFormat('0%');
  sheet.setColumnWidth(1, 300);
  sheet.setColumnWidth(2, 100);

  // 分類別の件数（設定シートの分類から作る）
  const categories = getSettings_().categories;
  sheet.getRange(24, 1, 1, 2).setValues([['■ AI分類別の件数', '件数']]).setFontWeight('bold').setBackground('#e8f0fe');
  categories.forEach(function (c, i) {
    sheet.getRange(25 + i, 1, 1, 2).setValues([[c.name, '=COUNTIF(' + R('AI分類') + ',"' + c.name.replace(/"/g, '""') + '")']]);
  });

  // 右側: 高優先度の未完了案件 と エラー・要確認の案件の一覧
  sheet.getRange('D3').setValue('■ 高優先度で未完了の案件').setFontWeight('bold');
  sheet.getRange('D4:H4').setValues([['受付ID', '受付日時', '件名', '希望期限', '対応状況']]).setFontWeight('bold').setBackground('#f4c7c3');
  sheet.getRange('D5').setFormula('=IFERROR(FILTER({' + [R('受付ID'), R('受付日時'), R('件名'), R('希望期限'), R('対応状況')].join(',') +
    '},' + R('優先度') + '="高",' + R('対応状況') + '<>"完了"),"該当なし")');

  sheet.getRange('J3').setValue('■ 処理エラー・要確認の案件（「注意・エラー内容」を確認してください）').setFontWeight('bold');
  sheet.getRange('J4:M4').setValues([['受付ID', '件名', 'AI処理状況', '注意・エラー内容']]).setFontWeight('bold').setBackground('#fce8b2');
  sheet.getRange('J5').setFormula('=IFERROR(FILTER({' + [R('受付ID'), R('件名'), R('AI処理状況'), R('注意・エラー内容')].join(',') +
    '},(' + R('AI処理状況') + '="エラー")+(' + R('AI処理状況') + '="要確認")),"該当なし")');
  sheet.setColumnWidth(4, 150);
  sheet.setColumnWidth(5, 140);
  sheet.setColumnWidth(6, 220);
  sheet.setColumnWidth(10, 150);
  sheet.setColumnWidth(11, 220);
  sheet.setColumnWidth(13, 400);
}

function columnLetter_(n) {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function createInquiryForm_() {
  const settings = getSettings_();
  const form = FormApp.create('お問い合わせフォーム（' + settings['会社名'] + '）');
  form.setDescription('※これは FlowPilot のデモ用フォームです。実在の個人情報・企業情報は入力しないでください。\n' +
    'お問い合わせ内容を確認のうえ、担当者よりメールでご連絡いたします。');
  form.setCollectEmail(false);
  form.setLimitOneResponsePerUser(false);
  form.setConfirmationMessage('お問い合わせありがとうございました。担当者より折り返しご連絡いたします。');

  form.addTextItem().setTitle(FORM_ITEMS.NAME).setRequired(true);
  form.addTextItem().setTitle(FORM_ITEMS.COMPANY).setRequired(false);
  form.addTextItem().setTitle(FORM_ITEMS.EMAIL).setRequired(true)
    .setValidation(FormApp.createTextValidation().requireTextIsEmail().setHelpText('メールアドレスの形式で入力してください').build());
  form.addTextItem().setTitle(FORM_ITEMS.SUBJECT).setRequired(true);
  form.addParagraphTextItem().setTitle(FORM_ITEMS.BODY).setRequired(true);
  form.addDateItem().setTitle(FORM_ITEMS.DEADLINE).setRequired(false).setHelpText('ご希望の対応期限があればご入力ください（任意）');
  return form;
}

/** メニュー: OpenAI APIに接続できるか、架空の問い合わせ1件で確認する（シートには書き込まない） */
function testOpenAiConnection() {
  try {
    const sample = {
      '氏名': 'テスト 太郎', '会社名': '株式会社サンプル（架空）', '件名': 'エアコン交換の見積もり',
      '問い合わせ原文': '事務所のエアコン2台の交換を検討しています。見積もりをお願いできますか。', 'フォーム希望期限': '',
    };
    const r = analyzeInquiry_(sample, getSettings_());
    showMessage_('OpenAI APIへの接続に成功しました。\n\n分類: ' + r.data['AI分類'] + '\n優先度: ' + r.data['優先度'] + '\n要約: ' + r.data['要約']);
  } catch (e) {
    showMessage_('OpenAI APIへの接続に失敗しました。\n\n' + e.message);
  }
}
