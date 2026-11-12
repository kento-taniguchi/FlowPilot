/**
 * Main.js — FlowPilot の処理の流れ（メニュー・フォーム受付・案件処理・再処理）
 *
 * 処理の流れ:
 *   フォーム送信 → onFormSubmitHandler
 *     → registerInquiry_  : 受付IDを発行して原文を「案件管理」に保存（AI処理状況=受付済）
 *     → processCase_      : AI分析 → Google Tasks → Gmail下書き（各ステップの結果を記録）
 */

/** スプレッドシートを開いたときにメニューを追加する */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('FlowPilot')
    .addItem('初期セットアップ', 'setupFlowPilot')
    .addItem('OpenAI接続テスト', 'testOpenAiConnection')
    .addSeparator()
    .addItem('エラー・未完了の案件をまとめて再処理', 'retryPendingCases')
    .addItem('選択中の行の案件を再処理', 'retrySelectedRow')
    .addSeparator()
    .addItem('テストデータをフォームから送信', 'submitTestCases')
    .addItem('テスト結果を評価（分類精度など）', 'evaluateTestResults')
    .addToUi();
}

/** フォーム送信時に自動で呼ばれる（トリガーは初期セットアップで作成） */
function onFormSubmitHandler(e) {
  try {
    const inquiry = extractInquiryFromFormEvent_(e);
    const row = registerInquiry_(inquiry);
    if (row) processCase_(row);
  } catch (err) {
    // ここで失敗しても、問い合わせはフォーム側に残っており、自動復旧（autoRecover）で取り込まれる
    appendLog_('ERROR', '', 'フォーム受付', err.message + '（自動復旧で後から処理されます）');
  }
}

/**
 * 自動復旧（10分ごとに自動実行。トリガーは初期セットアップで作成）
 *  1. フォームの回答のうち、案件管理に記録されていないものを取り込む
 *  2. 受付済・止まった処理中・エラー（自動再試行3回まで）の案件を処理する
 */
function autoRecover() {
  const imported = syncMissingResponses_();
  const summary = processPendingCases_(true);
  if (imported || summary.done || summary.review || summary.error) {
    appendLog_('INFO', '', '自動復旧', '取り込み ' + imported + '件 / 完了 ' + summary.done + '件 / 要確認 ' + summary.review + '件 / エラー ' + summary.error + '件');
  }
}

/** フォームの回答（直近3日分）のうち、案件管理に無いものを取り込む。取り込んだ件数を返す */
function syncMissingResponses_() {
  const formId = PropertiesService.getScriptProperties().getProperty(FP.PROP_FORM_ID);
  if (!formId) return 0;
  const sheet = getSheet_(FP.SHEET_CASES);
  const known = {};
  if (sheet.getLastRow() >= 2) {
    const col = getHeaderMap_(sheet)['フォーム回答ID'];
    sheet.getRange(2, col, sheet.getLastRow() - 1, 1).getValues().forEach(function (r) { known[String(r[0])] = true; });
  }
  const since = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  let imported = 0;
  FormApp.openById(formId).getResponses(since).forEach(function (response) {
    if (known[response.getId()]) return;
    const row = registerInquiry_(extractInquiryFromFormEvent_({ response: response }));
    if (row) {
      imported++;
      appendLog_('WARN', '', '自動復旧', 'フォーム回答の取り込み漏れを検出し、行 ' + row + ' に取り込みました');
    }
  });
  return imported;
}

/** フォームの回答から問い合わせ情報を取り出す */
function extractInquiryFromFormEvent_(e) {
  const response = e.response;
  const answers = {};
  response.getItemResponses().forEach(function (ir) {
    answers[ir.getItem().getTitle()] = ir.getResponse();
  });
  return {
    responseId: response.getId(),
    timestamp: response.getTimestamp(),
    name: answers[FORM_ITEMS.NAME] || '',
    company: answers[FORM_ITEMS.COMPANY] || '',
    email: answers[FORM_ITEMS.EMAIL] || '',
    subject: answers[FORM_ITEMS.SUBJECT] || '',
    body: answers[FORM_ITEMS.BODY] || '',
    deadline: answers[FORM_ITEMS.DEADLINE] || '',
  };
}

/**
 * 問い合わせを案件管理シートに保存し、行番号を返す。
 * 同じフォーム回答が2回届いた場合（トリガーの二重起動など）は保存せず 0 を返す。
 */
function registerInquiry_(inq) {
  const lock = LockService.getScriptLock();
  // 問い合わせが集中しても待てるよう長めに待つ（それでも取れなければ自動復旧で後から取り込む）
  if (!lock.tryLock(120000)) throw new Error('混雑のため問い合わせを保存できませんでした');
  let receiptId, row;
  try {
    const sheet = getSheet_(FP.SHEET_CASES);
    if (inq.responseId && findRowByValue_(sheet, 'フォーム回答ID', inq.responseId)) {
      receiptId = null;
    } else {
      receiptId = issueReceiptId_();
      row = appendInquiryRow_(sheet, receiptId, inq);
    }
  } finally {
    lock.releaseLock();
  }
  // ログ書き込みはロックの外で行い、ロックを持つ時間を短くする
  if (!receiptId) {
    appendLog_('WARN', '', '受付', '同じフォーム回答の重複通知を無視しました（' + inq.responseId + '）');
    return 0;
  }
  appendLog_('INFO', receiptId, '受付', '問い合わせを保存しました（行 ' + row + '）');
  return row;
}

/** 案件管理シートに1行追加し、行番号を返す（ロック中に呼ぶこと） */
function appendInquiryRow_(sheet, receiptId, inq) {
  const map = getHeaderMap_(sheet);
  const rowValues = new Array(sheet.getLastColumn()).fill('');
  const set = function (h, v) { rowValues[map[h] - 1] = safeCell_(v); };
  set('受付ID', receiptId);
  set('受付日時', Utilities.formatDate(inq.timestamp || new Date(), Session.getScriptTimeZone(), 'yyyy/MM/dd HH:mm:ss'));
  set('氏名', String(inq.name));
  set('会社名', String(inq.company));
  set('メールアドレス', String(inq.email).trim());
  set('件名', String(inq.subject));
  set('問い合わせ原文', String(inq.body));
  set('フォーム希望期限', normalizeDate_(inq.deadline));
  set('対応状況', '未対応');
  set('AI処理状況', AI_STATUS.RECEIVED);
  set('再試行回数', 0);
  set('フォーム回答ID', String(inq.responseId || ''));
  set('最終更新日時', nowText_());
  sheet.appendRow(rowValues);
  SpreadsheetApp.flush();
  return sheet.getLastRow();
}

/** 受付IDを発行する（例: FP-20261112-0001）。ロック中に呼ぶこと */
function issueReceiptId_() {
  const props = PropertiesService.getScriptProperties();
  const seq = Number(props.getProperty(FP.PROP_SEQ) || '0') + 1;
  props.setProperty(FP.PROP_SEQ, String(seq));
  const day = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd');
  return 'FP-' + day + '-' + ('000' + seq).slice(-4);
}

/**
 * 案件を処理する（AI分析 → タスク → 下書き）。
 * すでに完了している手順はスキップするので、何度実行しても重複作成されない。
 */
function processCase_(row) {
  const startedAt = Date.now();
  const sheet = getSheet_(FP.SHEET_CASES);
  if (!claimCase_(sheet, row)) return null;

  let c = readCase_(sheet, row);
  const receiptId = c['受付ID'];
  const notes = [];
  let needsReview = false;

  // 1) AI分析（要約が空のときだけ実行。人が修正した内容は上書きしない）
  if (!String(c['要約']).trim()) {
    try {
      const result = analyzeInquiry_(c, getSettings_());
      writeFields_(sheet, row, result.data);
      writeFields_(sheet, row, { 'AI処理秒数': Math.round((Date.now() - startedAt) / 100) / 10 });
      result.warnings.forEach(function (w) { notes.push(w); appendLog_('WARN', receiptId, 'AI分析', w); });
      if (result.needsReview) needsReview = true;
      appendLog_('INFO', receiptId, 'AI分析', '分類: ' + result.data['AI分類'] + ' / 優先度: ' + result.data['優先度']);
      c = readCase_(sheet, row);
    } catch (e) {
      appendLog_('ERROR', receiptId, 'AI分析', e.message);
      return finishCase_(sheet, row, c, AI_STATUS.ERROR, ['AI分析に失敗: ' + e.message]);
    }
  }

  // 2) Google Tasks、3) Gmail下書き（片方が失敗しても、もう片方は実行する）
  let hasError = false;
  [['Tasks', ensureTask_], ['Gmail', ensureDraft_]].forEach(function (step) {
    let r;
    try {
      r = step[1](sheet, row, c);
    } catch (e) {
      r = { error: true, message: step[0] + 'の処理でエラー: ' + e.message };
    }
    if (r.review) { needsReview = true; notes.push(r.message); appendLog_('WARN', receiptId, step[0], r.message); }
    if (r.error) { hasError = true; notes.push(r.message); appendLog_('ERROR', receiptId, step[0], r.message); }
    c = readCase_(sheet, row);
  });

  const status = needsReview ? AI_STATUS.REVIEW : (hasError ? AI_STATUS.ERROR : AI_STATUS.DONE);
  return finishCase_(sheet, row, c, status, notes);
}

/**
 * 処理を始めてよいか確認し、AI処理状況を「処理中」にする（同時に2回処理されるのを防ぐ）
 */
function claimCase_(sheet, row) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(120000)) {
    appendLog_('WARN', '', '処理開始', '混雑のため行 ' + row + ' の処理を延期しました（自動復旧で後から処理されます）');
    return false;
  }
  let skippedId = null;
  try {
    const c = readCase_(sheet, row);
    const status = String(c['AI処理状況']);
    if (!c['受付ID']) return false;
    if (status === AI_STATUS.DONE) return false;
    if (status === AI_STATUS.PROCESSING && !isStale_(c['最終更新日時'])) {
      skippedId = c['受付ID'];
    } else {
      writeFields_(sheet, row, { 'AI処理状況': AI_STATUS.PROCESSING, '最終更新日時': nowText_() });
      SpreadsheetApp.flush();
      return true;
    }
  } finally {
    lock.releaseLock();
  }
  appendLog_('WARN', skippedId, '処理開始', '別の処理が実行中のためスキップしました');
  return false;
}

function isStale_(updated) {
  // シートが日時を自動で日付型に変換する場合と、文字列のままの場合の両方に対応
  const t = Object.prototype.toString.call(updated) === '[object Date]'
    ? updated.getTime()
    : new Date(String(updated).replace(/\//g, '-').replace(' ', 'T') + '+09:00').getTime();
  if (isNaN(t)) return true;
  return Date.now() - t > FP.STALE_MINUTES * 60 * 1000;
}

function finishCase_(sheet, row, c, status, notes) {
  const fields = {
    'AI処理状況': status,
    '注意・エラー内容': notes.join(' / ').slice(0, 2000),
    '最終更新日時': nowText_(),
  };
  if (status === AI_STATUS.ERROR) fields['再試行回数'] = Number(c['再試行回数'] || 0) + 1;
  writeFields_(sheet, row, fields);
  appendLog_(status === AI_STATUS.DONE ? 'INFO' : 'WARN', c['受付ID'], '処理結果', 'AI処理状況: ' + status);
  return status;
}

/** メニュー: 取り込み漏れのチェックと、エラー・受付済・止まった処理中 の案件をまとめて再処理 */
function retryPendingCases() {
  const imported = syncMissingResponses_();
  const summary = processPendingCases_(false);
  const msg = '再処理が終わりました。\n' +
    (imported ? 'フォームからの取り込み漏れ: ' + imported + '件を取り込みました\n' : '') +
    '完了: ' + summary.done + '件 / 要確認: ' + summary.review + '件 / エラー: ' + summary.error + '件' +
    (summary.skipped ? '\n時間切れで未処理: ' + summary.skipped + '件（もう一度実行してください）' : '');
  showMessage_(msg);
  return summary;
}

/**
 * 再処理が必要な案件を順番に処理する。
 * auto=true（自動復旧）のときは、エラーの案件は再試行回数3回未満のものだけ（APIの無駄な呼び出しを防ぐ）
 */
function processPendingCases_(auto) {
  const sheet = getSheet_(FP.SHEET_CASES);
  const startedAt = Date.now();
  const summary = { done: 0, review: 0, error: 0, skipped: 0 };
  if (sheet.getLastRow() < 2) return summary;
  const col = getHeaderMap_(sheet);
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  for (let i = 0; i < values.length; i++) {
    const v = function (h) { return values[i][col[h] - 1]; };
    const status = String(v('AI処理状況'));
    const stale = status === AI_STATUS.PROCESSING && isStale_(v('最終更新日時'));
    const retryableError = status === AI_STATUS.ERROR && (!auto || Number(v('再試行回数') || 0) < 3);
    if (status !== AI_STATUS.RECEIVED && !stale && !retryableError) continue;
    if (Date.now() - startedAt > FP.MAX_RUN_MS) { summary.skipped++; continue; }
    const r = processCase_(i + 2);
    if (r === AI_STATUS.DONE) summary.done++;
    else if (r === AI_STATUS.REVIEW) summary.review++;
    else if (r === AI_STATUS.ERROR) summary.error++;
  }
  return summary;
}

/**
 * メニュー: 選択中の行を再処理（「要確認」の案件を人が確認した後に使う）
 * 要約が入っている場合はAI分析をやり直さず、タスクと下書きの確認・作成だけ行う。
 */
function retrySelectedRow() {
  const sheet = SpreadsheetApp.getActiveSheet();
  if (sheet.getName() !== FP.SHEET_CASES) { showMessage_('「案件管理」シートで、再処理したい案件の行を選んでから実行してください。'); return; }
  const row = sheet.getActiveRange().getRow();
  if (row < 2) { showMessage_('見出し行ではなく、案件の行を選んでください。'); return; }
  const c = readCase_(sheet, row);
  if (String(c['AI処理状況']) === AI_STATUS.DONE) { showMessage_(c['受付ID'] + ' はすでに完了しています。'); return; }
  const r = processCase_(row);
  showMessage_(c['受付ID'] + ' の再処理結果: ' + (r || 'スキップ（処理中の可能性があります）'));
}

/** 画面から実行したときはポップアップ、トリガー実行時はログに出す */
function showMessage_(msg) {
  try {
    SpreadsheetApp.getUi().alert(msg);
  } catch (e) {
    console.log(msg);
  }
}
