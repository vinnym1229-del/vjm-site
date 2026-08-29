// Quiz answer-shape auditor.
//
// A quiz whose correct answer is reliably the longest option is not an
// assessment — it can be passed without reading the lesson. This measures
// that leak. Run: node tools/quiz-audit.mjs [file.html ...]
//
// Reports, per page and overall: how often the correct answer is the longest
// option (chance is 1/optionCount, i.e. ~25% for four options) and how much
// longer the correct answer runs than the average option.
import { readFileSync } from 'node:fs';

const PAGES = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['stock-breakdown.html', 'options-lab.html', 'futures-dissection.html', 'psychology-enhancer.html'];

const strip = (s) => s.replace(/<[^>]+>/g, '').replace(/&[a-z]+;/gi, ' ').trim();

let gTotal = 0;
let gLongest = 0;
let gCorrectLen = 0;
let gAvgLen = 0;
const rows = [];

for (const page of PAGES) {
  const html = readFileSync(page, 'utf8');
  const quizzes = html.match(/<div class="quiz">[\s\S]*?<script type="application\/json">[\s\S]*?<\/script>/g) || [];
  let total = 0;
  let longest = 0;
  let cLen = 0;
  let aLen = 0;

  for (const q of quizzes) {
    const key = JSON.parse(/<script type="application\/json">([\s\S]*?)<\/script>/.exec(q)[1]);
    const blocks = q.split(/<div class="quiz-q" data-qi="\d+">/).slice(1);
    blocks.forEach((b, bi) => {
      const choices = [...b.matchAll(/<span>([\s\S]*?)<\/span>/g)].map((m) => strip(m[1]));
      if (choices.length < 2 || bi >= key.length) return;
      const correct = key[bi].correct;
      if (!Number.isInteger(correct) || correct >= choices.length) return;
      const lens = choices.map((c) => c.length);
      total += 1;
      if (lens[correct] === Math.max(...lens)) longest += 1;
      cLen += lens[correct];
      aLen += lens.reduce((a, b2) => a + b2, 0) / lens.length;
    });
  }
  if (!total) continue;
  rows.push({ page, total, longest, pct: (longest / total) * 100, ratio: cLen / aLen });
  gTotal += total; gLongest += longest; gCorrectLen += cLen; gAvgLen += aLen;
}

for (const r of rows) {
  console.log(`${r.page.padEnd(26)} ${String(r.total).padStart(3)} questions  longest-is-correct ${r.pct.toFixed(0).padStart(3)}%  length ratio ${r.ratio.toFixed(2)}x`);
}
const pct = (gLongest / gTotal) * 100;
console.log('-'.repeat(78));
console.log(`OVERALL ${String(gTotal).padStart(20)} questions  longest-is-correct ${pct.toFixed(0).padStart(3)}%  length ratio ${(gCorrectLen / gAvgLen).toFixed(2)}x`);
console.log(`chance level for 4 options is 25%; anything above ~45% means the quiz leaks its answers`);
process.exitCode = pct > 45 ? 1 : 0;
