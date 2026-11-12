/**
 * Integrations.js — Google Tasks と Gmail下書きの作成
 *
 * 重複防止の仕組み（タスク・下書き共通）:
 *   1. 作成する前に、ID列へ「作成中」と書き込む
 *   2. 作成に成功したら、ID列を本物のIDで上書きする
 *   3. 次回の処理でID列が「作成中」のままなら「途中で止まった＝作成されたか不明」と判断し、
 *      受付IDで既存のタスク・下書きを検索する。見つかればそのIDを記録、
 *      見つからなければ新しく作らず「要確認」にして人間の確認を求める。
 *
 * ※ メールは「下書き」を作るだけで、送信する処理は一切ありません。
 */

/**
 * タスクを確実に1つだけ作る。
 * 戻り値: { ok: true } / { review: true, message } / { error: true, message }
 */
function ensureTask_(sheet, row, c) {
  const current = String(c['TasksタスクID'] || '').trim();
  if (current && current !== FP.MARKER_IN_PROGRESS) return { ok: true };

  if (current === FP.MARKER_IN_PROGRESS) {
    return recoverTask_(sheet, row, c, '前回の処理が途中で止まりました');
  }

  writeFields_(sheet, row, { 'TasksタスクID': FP.MARKER_IN_PROGRESS });
  SpreadsheetApp.flush();
  try {
    const task = Tasks.Tasks.insert(buildTask_(c), getTaskListId_());
    writeFields_(sheet, row, { 'TasksタスクID': task.id });
    appendLog_('INFO', c['受付ID'], 'Tasks', 'タスクを作成しました（' + task.id + '）');
    return { ok: true };
  } catch (e) {
    appendLog_('WARN', c['受付ID'], 'Tasks', 'タスク作成でエラー: ' + e.message);
    return recoverTask_(sheet, row, c, 'タスク作成でエラー: ' + e.message);
  }
}

/** 「作成中」のまま残ったタスクを受付IDで探して回復する */
function recoverTask_(sheet, row, c, reason) {
  let found;
  try {
    found = findTaskByReceiptId_(c['受付ID']);
  } catch (e) {
    return { review: true, message: reason + '。Google Tasksの確認もできませんでした。Tasksを確認し、タスクが無ければ「TasksタスクID」のセルを空にして再処理してください。' };
  }
  if (found) {
    writeFields_(sheet, row, { 'TasksタスクID': found.id });
    appendLog_('INFO', c['受付ID'], 'Tasks', '既存のタスクを見つけてIDを記録しました（重複作成なし）');
    return { ok: true };
  }
  // Google Tasks は作成直後でも一覧に反映されるため、見つからなければ「作成されていない」と判断できる
  writeFields_(sheet, row, { 'TasksタスクID': '' });
  return { error: true, message: reason + '（タスクは作成されていないことを確認済み。再処理できます）' };
}

function buildTask_(c) {
  const notes = [
    '受付ID: ' + c['受付ID'],
    '優先度: ' + c['優先度'],
    'お客様: ' + [c['会社名'], c['氏名']].filter(String).join(' / '),
    '',
    '■要約',
    c['要約'],
    '',
    '■必要な対応',
    c['必要な対応'],
    '',
    '■不足情報',
    c['不足情報'],
  ].join('\n').slice(0, 8000);
  const task = { title: String(c['タスク名'] || ('【問い合わせ】' + c['受付ID'])).slice(0, 1000), notes: notes };
  const due = normalizeDate_(c['希望期限']);
  if (due) task.due = due + 'T00:00:00.000Z'; // 期限が明確な場合のみ設定（Tasksは日付のみ使用）
  return task;
}

function findTaskByReceiptId_(receiptId) {
  const listId = getTaskListId_();
  let pageToken;
  do {
    const res = Tasks.Tasks.list(listId, { showCompleted: true, showHidden: true, maxResults: 100, pageToken: pageToken });
    const items = res.items || [];
    for (let i = 0; i < items.length; i++) {
      if (String(items[i].notes || '').indexOf('受付ID: ' + receiptId) >= 0) return items[i];
    }
    pageToken = res.nextPageToken;
  } while (pageToken);
  return null;
}

function getTaskListId_() {
  const id = PropertiesService.getScriptProperties().getProperty(FP.PROP_TASKLIST_ID);
  if (!id) throw new Error('Google Tasksのリストが未作成です。初期セットアップを実行してください。');
  return id;
}

/**
 * Gmail下書きを確実に1つだけ作る。
 * 戻り値: { ok: true } / { review: true, message } / { error: true, message }
 */
function ensureDraft_(sheet, row, c) {
  const current = String(c['Gmail下書きID'] || '').trim();
  if (current && current !== FP.MARKER_IN_PROGRESS) return { ok: true };

  if (current === FP.MARKER_IN_PROGRESS) {
    return recoverDraft_(sheet, row, c, '前回の処理が途中で止まりました');
  }

  let raw;
  try {
    raw = buildDraftRaw_(c); // 宛先チェックなど、作成前に分かるエラーはここで出る
  } catch (e) {
    return { error: true, message: '下書きを作成できません: ' + e.message };
  }

  writeFields_(sheet, row, { 'Gmail下書きID': FP.MARKER_IN_PROGRESS });
  SpreadsheetApp.flush();
  try {
    const draft = Gmail.Users.Drafts.create({ message: { raw: raw } }, 'me');
    writeFields_(sheet, row, { 'Gmail下書きID': draft.id });
    appendLog_('INFO', c['受付ID'], 'Gmail', '返信の下書きを作成しました（送信はしていません）');
    return { ok: true };
  } catch (e) {
    appendLog_('WARN', c['受付ID'], 'Gmail', '下書き作成でエラー: ' + e.message);
    return recoverDraft_(sheet, row, c, '下書き作成でエラー: ' + e.message);
  }
}

/**
 * 「作成中」のまま残った下書きを受付IDで探す。
 * Gmailの検索は反映に時間がかかることがあるため、見つからない場合は自動で作り直さず人間に確認を求める。
 */
function recoverDraft_(sheet, row, c, reason) {
  try {
    const res = Gmail.Users.Drafts.list('me', { q: '"' + c['受付ID'] + '"', maxResults: 5 });
    const drafts = (res && res.drafts) || [];
    if (drafts.length === 1) {
      writeFields_(sheet, row, { 'Gmail下書きID': drafts[0].id });
      appendLog_('INFO', c['受付ID'], 'Gmail', '既存の下書きを見つけてIDを記録しました（重複作成なし）');
      return { ok: true };
    }
  } catch (e) {
    // 検索できなかった場合も下の「要確認」へ
  }
  return {
    review: true,
    message: reason + '。下書きが作成されたか確認できません。Gmailの下書きを件名の受付ID「' + c['受付ID'] +
      '」で検索し、無ければ「Gmail下書きID」のセルを空にして再処理してください（有ればそのままでOK）。',
  };
}

/** Gmail API 用のメール本体（MIME形式）を作り、URL安全なBase64で返す */
function buildDraftRaw_(c) {
  const to = String(c['メールアドレス'] || '').trim();
  // 改行を含む宛先はヘッダーインジェクションの恐れがあるため拒否する
  if (!/^[^\s@<>()",;:\\\[\]]+@[^\s@<>()",;:\\\[\]]+\.[^\s@<>()",;:\\\[\]]+$/.test(to)) {
    throw new Error('メールアドレスの形式が正しくありません: ' + to.slice(0, 100));
  }
  const subjectText = 'Re: ' + oneLine_(c['件名']).slice(0, 100) + ' [' + c['受付ID'] + ']';
  const settings = getSettings_();
  const bodyText = String(c['返信文案'] || '') + '\n\n' + settings['返信署名'];
  const mime = [
    'To: ' + to,
    'Subject: =?UTF-8?B?' + Utilities.base64Encode(subjectText, Utilities.Charset.UTF_8) + '?=',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Utilities.base64Encode(bodyText, Utilities.Charset.UTF_8).replace(/(.{76})/g, '$1\r\n'),
  ].join('\r\n');
  return Utilities.base64EncodeWebSafe(mime);
}

function oneLine_(s) {
  return String(s || '').replace(/[\r\n\t]+/g, ' ').trim();
}
