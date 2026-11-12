/**
 * SheetStore.js — スプレッドシートの読み書きと処理ログ
 *
 * 列は「見出しの名前」で探すため、担当者が列の幅や色を変えても動きます。
 * （見出しの文字そのものは変更しないでください）
 */

function getSheet_(name) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) throw new Error('シート「' + name + '」がありません。メニュー「FlowPilot」→「初期セットアップ」を実行してください。');
  return sheet;
}

/** 見出し行から { 見出し名: 列番号(1始まり) } を作る */
function getHeaderMap_(sheet) {
  const lastCol = sheet.getLastColumn();
  const headers = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  const map = {};
  headers.forEach(function (h, i) { if (h !== '') map[String(h)] = i + 1; });
  CASE_HEADERS.forEach(function (h) {
    if (sheet.getName() === FP.SHEET_CASES && !map[h]) {
      throw new Error('案件管理シートに列「' + h + '」がありません。初期セットアップを再実行してください。');
    }
  });
  return map;
}

/** 1行分を { 見出し名: 値 } で読み込む */
function readCase_(sheet, row) {
  const map = getHeaderMap_(sheet);
  const values = sheet.getRange(row, 1, 1, sheet.getLastColumn()).getValues()[0];
  const obj = { _row: row };
  Object.keys(map).forEach(function (h) { obj[h] = values[map[h] - 1]; });
  return obj;
}

/** 指定した列だけを書き換える。fields = { 見出し名: 値 } */
function writeFields_(sheet, row, fields) {
  const map = getHeaderMap_(sheet);
  Object.keys(fields).forEach(function (h) {
    if (!map[h]) throw new Error('列「' + h + '」がありません');
    sheet.getRange(row, map[h]).setValue(safeCell_(fields[h]));
  });
}

/**
 * セルに書き込む値を安全にする。
 * 「=」「+」「-」「@」で始まる文字列は数式として実行されてしまうため（数式インジェクション）、
 * 先頭に「'」を付けて文字列として保存する。
 */
function safeCell_(value) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') return value;
  if (/^[=+\-@]/.test(value)) return "'" + value;
  // 「2026-11-30」のような日付だけの値は、シートの自動変換（時差で1日ずれる原因）を避けて文字として保存
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return "'" + value;
  return value;
}

/** 受付IDで案件の行番号を探す（無ければ 0） */
function findRowByValue_(sheet, header, value) {
  if (!value || sheet.getLastRow() < 2) return 0;
  const col = getHeaderMap_(sheet)[header];
  const values = sheet.getRange(2, col, sheet.getLastRow() - 1, 1).getValues();
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0]) === String(value)) return i + 2;
  }
  return 0;
}

function nowText_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy/MM/dd HH:mm:ss');
}

/**
 * 処理ログに1行追加する（APIキーなどの秘密情報は絶対に渡さないこと）
 * level: INFO / WARN / ERROR
 */
function appendLog_(level, receiptId, step, message) {
  const text = String(message || '').slice(0, 1000);
  console.log('[' + level + '] ' + (receiptId || '-') + ' ' + step + ': ' + text);
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(FP.SHEET_LOG);
    if (sheet) sheet.appendRow([nowText_(), level, receiptId || '', step, safeCell_(text)]);
  } catch (e) {
    console.error('ログの書き込みに失敗: ' + e.message);
  }
}
