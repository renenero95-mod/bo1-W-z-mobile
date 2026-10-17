const CUSTOM = 0;
const TYPE = 1;
const IMPORT = 2;
const GLOBAL = 6;
const EXPORT = 7;
const START = 8;
const ELEMENT = 9;
const CODE = 10;
const DATA = 11;

export type Section = { id: number; head: number; start: number; end: number };
export type Body = { head: number; start: number; code: number; end: number };
export type Module = {
  bytes: Uint8Array; sections: Section[]; importedFuncs: number; types: string[]; bodies: Body[]; names: Map<string, number>; nameSection?: Section;
};
// funcAt/funcEnd: the function index operand of a call or ref.func, which the rebuild renumbers.
export type Instruction = { at: number; end: number; op: number; sub?: number; index?: number; funcAt?: number; funcEnd?: number; offset?: number; value?: number };
export type Import = { module: string; name: string; params: number[]; results: number[] };
export type Edit = { at: number; end: number; bytes: ArrayLike<number> };

class Reader {
  bytes: Uint8Array;
  pos: number;

  constructor(bytes: Uint8Array, pos = 0) {
    this.bytes = bytes;
    this.pos = pos;
  }

  byte = () => this.bytes[this.pos++];

  u32() {
    let result = 0;
    let shift = 0;
    let byte;
    do {
      byte = this.byte();
      result |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    return result >>> 0;
  }

  s32() {
    let result = 0;
    let shift = 0;
    let byte;
    do {
      byte = this.byte();
      result |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    return shift < 32 && byte & 0x40 ? result | (-1 << shift) : result | 0;
  }

  skipLeb() {
    while (this.byte() & 0x80);
  }

  name() {
    const length = this.u32();
    const text = new TextDecoder().decode(this.bytes.subarray(this.pos, this.pos + length));
    this.pos += length;
    return text;
  }
}

export function leb(value: number) {
  const out: number[] = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value) byte |= 0x80;
    out.push(byte);
  } while (value);
  return out;
}

export function sleb(value: number) {
  const out: number[] = [];
  for (;;) {
    const byte = value & 0x7f;
    value >>= 7;
    if ((value === 0 && !(byte & 0x40)) || (value === -1 && byte & 0x40)) return [...out, byte];
    out.push(byte | 0x80);
  }
}

const nameBytes = (text: string) => {
  const encoded = new TextEncoder().encode(text);
  return [...leb(encoded.length), ...encoded];
};

function skipBlockType(r: Reader) {
  const byte = r.bytes[r.pos];
  if (byte === 0x40 || (byte >= 0x69 && byte <= 0x7f)) r.pos++;
  else r.skipLeb();
}

function memarg(r: Reader) {
  const align = r.u32();
  if (align & 0x40) r.u32();
  return r.u32();
}

function instruction(r: Reader): Instruction {
  const at = r.pos;
  const op = r.byte();
  const ins: Instruction = { at, op, end: at };
  if (op === 0x02 || op === 0x03 || op === 0x04 || op === 0x06) skipBlockType(r);
  else if (op === 0x10 || op === 0x12 || op === 0xd2) {
    ins.funcAt = r.pos;
    ins.index = r.u32();
    ins.funcEnd = r.pos;
  } else if ((op >= 0x07 && op <= 0x09) || op === 0x0c || op === 0x0d || op === 0x14 || op === 0x15 || op === 0x18
    || (op >= 0x20 && op <= 0x26) || op === 0x3f || op === 0x40 || op === 0xd4 || op === 0xd6) ins.index = r.u32();
  else if (op === 0x0e) {
    const count = r.u32();
    for (let i = 0; i <= count; i++) r.u32();
  } else if (op === 0x11 || op === 0x13) {
    r.u32();
    r.u32();
  } else if (op === 0x1c) {
    const count = r.u32();
    r.pos += count;
  } else if (op >= 0x28 && op <= 0x3e) ins.offset = memarg(r);
  else if (op === 0x41) ins.value = r.s32();
  else if (op === 0x42) r.skipLeb();
  else if (op === 0x43) r.pos += 4;
  else if (op === 0x44) r.pos += 8;
  else if (op === 0xd0) skipBlockType(r);
  else if (op === 0xfc) {
    const sub = ins.sub = r.u32();
    if (sub === 8 || sub === 10 || sub === 12 || sub === 14) {
      r.u32();
      r.u32();
    } else if (sub === 9 || sub === 11 || sub === 13 || (sub >= 15 && sub <= 17)) r.u32();
    else if (sub > 7) throw new Error(`unknown 0xfc ${sub} at ${at}`);
  } else if (op === 0xfd) {
    const sub = ins.sub = r.u32();
    if (sub <= 11 || sub === 92 || sub === 93) ins.offset = memarg(r);
    else if (sub === 12 || sub === 13) r.pos += 16;
    else if (sub >= 21 && sub <= 34) r.pos += 1;
    else if (sub >= 84 && sub <= 91) {
      ins.offset = memarg(r);
      r.pos += 1;
    }
  } else if (op === 0xfe) {
    const sub = ins.sub = r.u32();
    if (sub === 3) r.pos += 1;
    else ins.offset = memarg(r);
  } else if (op === 0x1f || op === 0xfb) throw new Error(`unhandled opcode 0x${op.toString(16)} at ${at}`);
  ins.end = r.pos;
  return ins;
}

function locals(r: Reader) {
  const groups = r.u32();
  for (let i = 0; i < groups; i++) {
    r.u32();
    const type = r.byte();
    if (type === 0x63 || type === 0x64) r.skipLeb();
  }
}

export function* instructions(bytes: Uint8Array, start: number, end: number) {
  const r = new Reader(bytes, start);
  while (r.pos < end) yield instruction(r);
}

function sections(bytes: Uint8Array) {
  const r = new Reader(bytes, 8);
  const list: Section[] = [];
  while (r.pos < bytes.length) {
    const head = r.pos;
    const id = r.byte();
    const size = r.u32();
    list.push({ id, head, start: r.pos, end: r.pos + size });
    r.pos += size;
  }
  return list;
}

export function parse(bytes: Uint8Array) {
  const list = sections(bytes);
  const section = (id: number) => list.find(s => s.id === id)!;
  const module: Module = { bytes, sections: list, importedFuncs: 0, types: [], bodies: [], names: new Map() };

  const types = new Reader(bytes, section(TYPE).start);
  for (let count = types.u32(), i = 0; i < count; i++) {
    const at = types.pos;
    if (types.byte() !== 0x60) throw new Error(`type ${i} is not a function type`);
    for (let vec = 0; vec < 2; vec++) {
      const length = types.u32();
      types.pos += length;
    }
    module.types.push(bytes.subarray(at, types.pos).join(','));
  }

  const imports = new Reader(bytes, section(IMPORT).start);
  for (let count = imports.u32(), i = 0; i < count; i++) {
    imports.name();
    imports.name();
    const kind = imports.byte();
    if (kind === 0) {
      imports.u32();
      module.importedFuncs++;
    } else if (kind === 1) {
      imports.pos++;
      const flags = imports.u32();
      imports.u32();
      if (flags & 1) imports.u32();
    } else if (kind === 2) {
      const flags = imports.u32();
      imports.u32();
      if (flags & 1) imports.u32();
    } else if (kind === 3) imports.pos += 2;
    else if (kind === 4) {
      imports.pos++;
      imports.u32();
    }
  }

  const code = new Reader(bytes, section(CODE).start);
  for (let count = code.u32(), i = 0; i < count; i++) {
    const head = code.pos;
    const size = code.u32();
    const start = code.pos;
    locals(code);
    module.bodies.push({ head, start, code: code.pos, end: start + size });
    code.pos = start + size;
  }

  for (const custom of list.filter(s => s.id === CUSTOM)) {
    const r = new Reader(bytes, custom.start);
    if (r.name() !== 'name') continue;
    module.nameSection = custom;
    while (r.pos < custom.end) {
      const id = r.byte();
      const end = r.u32() + r.pos;
      if (id === 1) {
        for (let count = r.u32(), i = 0; i < count; i++) {
          const index = r.u32();
          module.names.set(r.name(), index);
        }
      }
      r.pos = end;
    }
  }
  return module;
}

// A threaded build keeps its data in passive segments, which __wasm_init_memory copies to fixed addresses.
function dataSegments(module: Module) {
  const { bytes } = module;
  const r = new Reader(bytes, module.sections.find(s => s.id === DATA)!.start);
  const segments: { start: number; end: number }[] = [];
  for (let count = r.u32(), i = 0; i < count; i++) {
    const flags = r.u32();
    if (flags !== 1) throw new Error(`data segment ${i} is not passive`);
    const length = r.u32();
    segments.push({ start: r.pos, end: r.pos + length });
    r.pos += length;
  }
  const init = module.bodies[module.names.get('__wasm_init_memory')! - module.importedFuncs];
  const list = [...instructions(bytes, init.code, init.end)];
  return list.flatMap((ins, k) => (ins.op === 0xfc && ins.sub === 8
    ? [{ address: list[k - 3].value!, ...segments[new Reader(bytes, ins.at + 2).u32()] }] : []));
}

export function stringAddress(module: Module, text: string) {
  const { bytes } = module;
  const needle = new TextEncoder().encode(`${text}\0`);
  for (const { address, start, end } of dataSegments(module)) {
    for (let at = start; at + needle.length <= end; at++) {
      if (needle.every((byte, j) => bytes[at + j] === byte)) return address + at - start;
    }
  }
  throw new Error(`missing string: ${text}`);
}

export function stringAt(module: Module, address: number) {
  const segment = dataSegments(module).find(s => address >= s.address && address < s.address + s.end - s.start);
  if (!segment) return null;
  const start = segment.start + address - segment.address;
  return new TextDecoder().decode(module.bytes.subarray(start, module.bytes.indexOf(0, start)));
}

class Writer {
  chunks: ArrayLike<number>[] = [];
  length = 0;

  push(bytes: ArrayLike<number>) {
    this.chunks.push(bytes);
    this.length += bytes.length;
    return this;
  }

  bytes() {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  }
}

type Renumber = (index: number) => number;

function constExpr(r: Reader, w: Writer, func: Renumber) {
  for (;;) {
    const ins = instruction(r);
    w.push(ins.op === 0xd2 ? [0xd2, ...leb(func(ins.index!))] : r.bytes.subarray(ins.at, ins.end));
    if (ins.op === 0x0b) return;
  }
}

function elementSection(bytes: Uint8Array, s: Section, func: Renumber) {
  const r = new Reader(bytes, s.start);
  const count = r.u32();
  const w = new Writer().push(leb(count));
  for (let i = 0; i < count; i++) {
    const flags = r.u32();
    w.push(leb(flags));
    if ((flags & 3) === 2) w.push(leb(r.u32()));
    if (!(flags & 1)) constExpr(r, w, func);
    if (flags & 3) w.push([r.byte()]);
    const items = r.u32();
    w.push(leb(items));
    for (let j = 0; j < items; j++) {
      if (flags & 4) constExpr(r, w, func);
      else w.push(leb(func(r.u32())));
    }
  }
  return w.bytes();
}

function exportSection(bytes: Uint8Array, s: Section, func: Renumber) {
  const r = new Reader(bytes, s.start);
  const count = r.u32();
  const w = new Writer().push(leb(count));
  for (let i = 0; i < count; i++) {
    const at = r.pos;
    r.name();
    const kind = r.byte();
    w.push(bytes.subarray(at, r.pos));
    const index = r.u32();
    w.push(leb(kind === 0 ? func(index) : index));
  }
  return w.bytes();
}

function nameSection(bytes: Uint8Array, s: Section, func: Renumber, importedFuncs: number, added: string[]) {
  const r = new Reader(bytes, s.start);
  const w = new Writer().push(bytes.subarray(s.start, s.start + 5));
  r.name();
  while (r.pos < s.end) {
    const id = r.byte();
    const end = r.u32() + r.pos;
    const sub = new Writer();
    if (id === 1) {
      const count = r.u32();
      sub.push(leb(count + added.length));
      let inserted = false;
      const insertAdded = () => {
        added.forEach((name, i) => sub.push([...leb(importedFuncs + i), ...nameBytes(name)]));
        inserted = true;
      };
      for (let i = 0; i < count; i++) {
        const index = r.u32();
        const at = r.pos;
        r.name();
        if (index >= importedFuncs && !inserted) insertAdded();
        sub.push(leb(func(index))).push(bytes.subarray(at, r.pos));
      }
      if (!inserted) insertAdded();
    } else if (id === 2 || id === 3) {
      const count = r.u32();
      sub.push(leb(count));
      for (let i = 0; i < count; i++) {
        sub.push(leb(func(r.u32())));
        const at = r.pos;
        for (let inner = r.u32(), j = 0; j < inner; j++) {
          r.u32();
          r.name();
        }
        sub.push(bytes.subarray(at, r.pos));
      }
    } else sub.push(bytes.subarray(r.pos, end));
    r.pos = end;
    w.push([id, ...leb(sub.length)]).push(sub.bytes());
  }
  return w.bytes();
}

function codeSection(module: Module, s: Section, func: Renumber, shift: number, edits: Map<number, Edit[]>) {
  const { bytes, importedFuncs } = module;
  const r = new Reader(bytes, s.start);
  r.u32();
  const w = new Writer().push(bytes.subarray(s.start, r.pos));
  module.bodies.forEach((body, i) => {
    const patches = edits.get(importedFuncs + i) ?? [];
    const list = [...patches];
    const replaced = (at: number) => patches.some(patch => at >= patch.at && at < patch.end);
    if (shift) {
      for (const ins of instructions(bytes, body.code, body.end))
        if (ins.funcAt !== undefined && ins.index! >= importedFuncs && !replaced(ins.funcAt)) list.push({ at: ins.funcAt, end: ins.funcEnd!, bytes: leb(func(ins.index!)) });
    }
    if (!list.length) return w.push(bytes.subarray(body.head, body.end));
    list.sort((a, b) => a.at - b.at);
    const out = new Writer();
    let at = body.start;
    for (const edit of list) {
      if (edit.at < at) throw new Error(`overlapping edits in function ${importedFuncs + i}`);
      out.push(bytes.subarray(at, edit.at)).push(edit.bytes);
      at = edit.end;
    }
    out.push(bytes.subarray(at, body.end));
    w.push(leb(out.length)).push(out.bytes());
  });
  return w.bytes();
}

// imports: functions added after the existing imports, so every defined function moves up by imports.length.
// edits: original function index → [{ at, end, bytes }], absolute positions in the original binary.
export function rebuild(module: Module, { imports = [] as Import[], edits = new Map<number, Edit[]>() } = {}) {
  const { bytes, importedFuncs } = module;
  const shift = imports.length;
  const func = (index: number) => (index >= importedFuncs ? index + shift : index);
  const types = [...module.types];
  const typeOf = ({ params, results }: Import) => {
    const key = [0x60, ...leb(params.length), ...params, ...leb(results.length), ...results].join(',');
    return types.includes(key) ? types.indexOf(key) : types.push(key) - 1;
  };
  const importEntries = imports.map(entry => [...nameBytes(entry.module), ...nameBytes(entry.name), 0x00, ...leb(typeOf(entry))]);

  const out = new Writer().push(bytes.subarray(0, 8));
  for (const s of module.sections) {
    let content: Uint8Array | null = null;
    if (s.id === TYPE && types.length > module.types.length) {
      const w = new Writer().push(leb(types.length));
      types.forEach(key => w.push(key.split(',').map(Number)));
      content = w.bytes();
    } else if (s.id === IMPORT && shift) {
      const r = new Reader(bytes, s.start);
      const count = r.u32();
      const w = new Writer().push(leb(count + shift)).push(bytes.subarray(r.pos, s.end));
      importEntries.forEach(entry => w.push(entry));
      content = w.bytes();
    } else if (s.id === CODE && (shift || edits.size)) content = codeSection(module, s, func, shift, edits);
    else if (s.id === ELEMENT && shift) content = elementSection(bytes, s, func);
    else if (s.id === EXPORT && shift) content = exportSection(bytes, s, func);
    else if (s.id === START && shift) content = Uint8Array.from(leb(func(new Reader(bytes, s.start).u32())));
    else if (s.id === CUSTOM && s === module.nameSection && shift) content = nameSection(bytes, s, func, importedFuncs, imports.map(entry => entry.name));
    else if (s.id === GLOBAL && shift) {
      const r = new Reader(bytes, s.start);
      for (let count = r.u32(), i = 0; i < count; i++) {
        r.byte();
        r.byte();
        for (let ins = instruction(r); ins.op !== 0x0b; ins = instruction(r))
          if (ins.op === 0xd2) throw new Error('ref.func in a global: renumbering not handled');
      }
    }
    if (content) out.push([s.id, ...leb(content.length)]).push(content);
    else out.push(bytes.subarray(s.head, s.end));
  }
  return out.bytes();
}
