'use strict';

const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'data.txt');

function parse(file = DATA_FILE) {
  const raw = fs.readFileSync(file, 'utf8');
  const rows = [];
  raw.split(/\r?\n/).forEach((line, i) => {
    const text = line.trim();
    if (!text) return;
    const comma = text.indexOf(',');
    if (comma < 0) throw new Error(file + ':' + (i + 1) + ' 缺少逗号: ' + text);
    const name = text.slice(0, comma).trim();
    const value = Number(text.slice(comma + 1).trim());
    if (!name) throw new Error(file + ':' + (i + 1) + ' 名字为空: ' + text);
    if (!Number.isFinite(value)) throw new Error(file + ':' + (i + 1) + ' 数字非法: ' + text);
    rows.push({ name, value });
  });
  return rows;
}

function sum(file = DATA_FILE) {
  return parse(file).reduce((acc, r) => acc + r.value, 0);
}

function list(file = DATA_FILE) {
  return parse(file).map((r) => r.name);
}

module.exports = { sum, list };

if (require.main === module) {
  const rows = parse();
  console.log('共 ' + rows.length + ' 条记录');
  console.log('list() = ' + JSON.stringify(list()));
  console.log('sum()  = ' + sum());
}