const check = (ok, code) => { if (!ok) throw Error(code); };
const authorityFields = ['interaction_session_id', 'interaction_generation', 'next_interaction_serial', 'active_interaction_slots'];
export function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
  return value;
}
// Tag every original string VALUE as well as every exact numeric token.
// Keys remain keys; number1 and an original string '@number:1' cannot collide.
// This comparator never round-trips JS-rounded u64 values into restore.
export function lossless(raw) {
  
  let text = '', index = 0;
  while (index < raw.length) {
    if (raw[index] === '"') {
      const start = index++;
      while (index < raw.length) {
        if (raw[index] === '\\') { index += 2; continue; }
        if (raw[index++] === '"') break;
      }
      const token = raw.slice(start, index);
      let next = index; while (/\s/.test(raw[next] ?? '')) next++;
      text += raw[next] === ':' ? token : JSON.stringify('@string:' + JSON.parse(token));
    } else if (raw[index] === '-' || /[0-9]/.test(raw[index])) {
      const match = raw.slice(index).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/);
      check(match, 'lossless-number-token');
      text += JSON.stringify('@number:' + match[0]); index += match[0].length;
    } else text += raw[index++];
  }
  return JSON.parse(text);
}
export function canonical(raw) {
  
  const envelope = lossless(raw);
  check(envelope.state, 'trusted-envelope-state');
  for (const key of authorityFields) delete envelope.state[key];
  return stable(envelope);
}

export function equalRekey(expected, actual) {
  const a = canonical(expected), b = canonical(actual);
  const before = a.precast_shortcut_runtime, after = b.precast_shortcut_runtime;
  check(before && after && [before, after].every(r => r.offer === null && r.must_diverge === null && r.materializing === false), 'idle-private-precast-authority-only');
  const epoch = token => {
    check(typeof token === 'string' && /^@number:(?:0|[1-9][0-9]*)$/.test(token), 'exact-private-u64-epoch');
    const value = BigInt(token.slice(8)); check(value <= (1n << 64n) - 1n, 'private-epoch-within-u64'); return value;
  };
  const rotated = (epoch(before.next_epoch) + 1n) & ((1n << 64n) - 1n);
  check(epoch(after.next_epoch) === (rotated === 0n ? 1n : rotated), 'exact-saved-epoch-positive-rotation');
  const adjusted = { ...a, precast_shortcut_runtime: { ...before, next_epoch: after.next_epoch } };
  check(JSON.stringify(adjusted) === JSON.stringify(b), 'full-authoritative-envelope-and-RNG-exact-one-rekey');
  const x = lossless(expected).state.interaction_session_id, y = lossless(actual).state.interaction_session_id;
  check([x, y].every(v => /^@string:wasm-[0-9a-f]{16}$/.test(v)) && x !== y, 'fresh-engine-interaction-namespace');
}
