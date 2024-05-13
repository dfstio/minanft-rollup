import { Field, Poseidon, Reducer, Encoding } from "o1js";

export function hashWithPrefix(prefix: string, input: Field[]) {
  let init = salt(prefix);
  return Poseidon.update(init, input)[0];
}

export function prefixToField(prefix: string) {
  let fieldSize = Field.sizeInBytes;
  if (prefix.length >= fieldSize) throw Error("prefix too long");
  let stringBytes = stringToBytes(prefix);
  return Field.fromBytes(
    stringBytes.concat(Array(fieldSize - stringBytes.length).fill(0))
  );
}

export function stringToFields(s: string): Field[] {
  return Encoding.stringToFields(s);
}

export function stringFromFields(fields: Field[]): string {
  return Encoding.stringFromFields(fields);
}

export function calculateActionsHash(actions: string[][], actionState: Field) {
  let actionHash = fromJSON(actions).hash;
  return Actions.updateSequenceState(actionState, actionHash);
}

export function emptyActionsHash(): Field {
  return Reducer.initialActionState;
}

const prefixes = {
  event: "MinaZkappEvent******",
  sequenceEvents: "MinaZkappSeqEvents**",
};

function initialState() {
  return [Field(0), Field(0), Field(0)] as [Field, Field, Field];
}
function salt(prefix: string) {
  return Poseidon.update(initialState(), [prefixToField(prefix)]);
}

const encoder = new TextEncoder();

function stringToBytes(s: string) {
  return [...encoder.encode(s)];
}

type Event = Field[];

type Events = {
  hash: Field;
  data: Event[];
};

function emptyHashWithPrefix(prefix: string) {
  return salt(prefix)[0];
}

function fromJSON(json: string[][]) {
  let data = json.map((row) => row.map((e) => Field.fromJSON(e)));
  let hash = Actions.hash(data);
  return { data, hash };
}

const Actions = {
  empty(): Events {
    let hash = emptyHashWithPrefix("MinaZkappActionsEmpty");
    return { hash, data: [] };
  },
  pushEvent(actions: Events, event: Event): Events {
    let eventHash = hashWithPrefix(prefixes.event, event);
    let hash = hashWithPrefix(prefixes.sequenceEvents, [
      actions.hash,
      eventHash,
    ]);
    return { hash, data: [event, ...actions.data] };
  },
  fromList(events: Event[]): Events {
    return [...events].reverse().reduce(Actions.pushEvent, Actions.empty());
  },
  hash(events: Event[]) {
    return this.fromList(events).hash;
  },
  emptyActionState() {
    return emptyHashWithPrefix("MinaZkappActionStateEmptyElt");
  },
  updateSequenceState(state: Field, sequenceEventsHash: Field) {
    return hashWithPrefix(prefixes.sequenceEvents, [state, sequenceEventsHash]);
  },
};
