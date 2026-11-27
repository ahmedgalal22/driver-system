import { readFileSync } from 'node:fs';

const ENTITIES = readFileSync('./entities.js', 'utf8');
const CSS = readFileSync('./styles.css', 'utf8');
let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`);
  if (!condition) failures++;
};
const block = (source, start, end) => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  return from >= 0 && to >= 0 ? source.slice(from, to) : '';
};

console.log('\n— Vehicle Details markup contract —');
ok(ENTITIES.includes('<div class="ent-details-page vehicle-details-page">'),
  'Vehicle Details continues to use the existing scoped vehicle-details-page root');
ok(ENTITIES.includes('class="vehicle-details-hero"')
  && ENTITIES.includes('vehicle-details-back')
  && ENTITIES.includes('vehicle-details-identity')
  && ENTITIES.includes('vehicle-details-vehicle-chip'),
  'hero retains back control, identity, and vehicle chip without markup changes');

console.log('\n— available desktop content width —');
const pageRule = block(CSS, '.vehicle-details-page {', '.vehicle-details-hero {');
ok(/width:\s*100%/.test(pageRule)
  && /max-width:\s*none/.test(pageRule)
  && /min-width:\s*0/.test(pageRule)
  && /margin-inline:\s*0/.test(pageRule),
  'Vehicle Details consumes available sidebar-adjusted content width without a centered max-width cap');
ok(!/max-width:\s*1180px/.test(pageRule) && !/margin:\s*0\s+auto/.test(pageRule),
  'obsolete 1180px centered-page constraint is removed only from Vehicle Details');

console.log('\n— narrow-screen hero and table behavior —');
const mobile = block(CSS, '@media (max-width: 520px) {', '@media print {');
ok(/\.vehicle-details-hero\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s.test(mobile),
  'narrow hero switches to a single content column');
ok(/\.vehicle-details-identity\s*\{[^}]*grid-column:\s*auto[^}]*justify-content:\s*flex-start/s.test(mobile),
  'identity leaves its desktop center grid column on narrow screens');
ok(/\.vehicle-details-vehicle-chip\s*\{[^}]*justify-self:\s*stretch[^}]*max-width:\s*none/s.test(mobile)
  && !/\.vehicle-details-vehicle-chip\s*\{[^}]*max-width:\s*104px/s.test(mobile),
  'vehicle chip expands instead of being squeezed or clipped');
ok(/\.vehicle-details-tabs\s*\{[^}]*grid-template-columns:\s*1fr/s.test(mobile),
  'narrow tabs stack instead of compressing into unusable columns');
ok(/\.vehicle-details-table-wrap/.test(CSS) && /\.vehicle-details-table\s*\{\s*min-width:\s*640px/s.test(CSS),
  'financial tables retain existing wrapper-scoped horizontal scrolling contract');

console.log(`\n${failures === 0 ? '✅ ALL VEHICLE-DETAILS-RESPONSIVE-LAYOUT ASSERTIONS PASSED' : `❌ FAILURES: ${failures}`}`);
process.exitCode = failures ? 1 : 0;
