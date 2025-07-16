const store: Record<string, any> = {};

export function get(key: string) {
  return store[key];
}

export function set(key: string, value: any) {
  store[key] = value;
  console.log('\x1b[38;2;244;154;194mDatabase entry updated\x1b[0m');
  console.dir(store[key], { depth: null });
}