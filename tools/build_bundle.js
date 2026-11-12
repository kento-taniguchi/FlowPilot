/**
 * build_bundle.js — gas/ フォルダのファイルを1つにまとめ、Apps Script に貼り付けやすくする
 *
 *   実行方法:  node tools/build_bundle.js
 *   出力    :  dist/FlowPilot.gs（コード一式）と dist/appsscript.json（設定ファイル）
 */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const gasDir = path.join(root, 'gas');
const distDir = path.join(root, 'dist');
fs.mkdirSync(distDir, { recursive: true });

// 読み込み順は依存関係に影響しない（Apps Script は全ファイルの関数を共有する）が、読みやすさのため固定
const order = ['Config.js', 'SheetStore.js', 'Main.js', 'AiAnalyzer.js', 'Integrations.js', 'Setup.js', 'TestData.js'];
const extra = fs.readdirSync(gasDir).filter((f) => f.endsWith('.js') && !order.includes(f));
if (extra.length) throw new Error('order に追加されていないファイルがあります: ' + extra.join(', '));

const header = [
  '/**',
  ' * FlowPilot — AI業務フロー自動化システム（自動生成ファイル）',
  ' * このファイルは tools/build_bundle.js で gas/ フォルダの各ファイルを結合したものです。',
  ' * 修正するときは gas/ フォルダ側を編集し、もう一度 build_bundle.js を実行してください。',
  ' * 生成日時: ' + new Date().toISOString(),
  ' */',
  '',
].join('\n');

const body = order.map((f) => '// ===================== ' + f + ' =====================\n' +
  fs.readFileSync(path.join(gasDir, f), 'utf8').trim() + '\n').join('\n');

fs.writeFileSync(path.join(distDir, 'FlowPilot.gs'), header + body, 'utf8');
fs.copyFileSync(path.join(gasDir, 'appsscript.json'), path.join(distDir, 'appsscript.json'));
console.log('作成しました: dist/FlowPilot.gs（' + body.split('\n').length + '行）, dist/appsscript.json');
