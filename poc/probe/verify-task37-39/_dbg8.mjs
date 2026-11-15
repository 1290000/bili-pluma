import { matchPair, stripComments } from './check-fake-green-construction.mjs';
import { readFileSync } from 'node:fs';

const code = stripComments(readFileSync('tests/unit/content/panel/orphan-hint.test.ts', 'utf8'));
const at = code.search(new RegExp('function\\s+buildProbe\\s*\\('));
const openParen = code.indexOf('(', at);
const closeParen = matchPair(code, openParen, '(', ')');
console.log('at', at, 'openParen', openParen, 'closeParen', closeParen);
console.log('params =', JSON.stringify(code.slice(openParen, closeParen + 1)));
console.log('after =', JSON.stringify(code.slice(closeParen, closeParen + 60)));
const brace = code.indexOf('{', closeParen);
const end = matchPair(code, brace, '{', '}');
console.log('brace', brace, 'end', end);
console.log('block head =', JSON.stringify(code.slice(brace, brace + 80)));
console.log('block tail =', JSON.stringify(code.slice(Math.max(brace, end - 80), end + 1)));
