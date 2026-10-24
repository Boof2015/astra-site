// Undo / redo for the editor source. The textarea's native undo can't be used: any
// programmatic change (stamp, fix, drag, meta field) wipes it. Every change is committed here
// instead as a snapshot { text, start, end }.
//
// Bursts of one kind coalesce into a single undo step: typing ("type"), and gestures that
// carry an id ("drag:3", "nudge:12", "field:ar"). Everything else (stamp, fix, import) is
// always its own step.

const COALESCING = /^(type|drag:|nudge:|field:)/u;

export function createHistory({ limit = 500, groupMs = 1000 } = {}) {
  let undoStack = [];
  let redoStack = [];
  let present = null;
  let lastKind = null;
  let lastTime = 0;

  return {
    reset(snapshot) {
      undoStack = [];
      redoStack = [];
      present = snapshot;
      lastKind = null;
    },

    commit(snapshot, kind = "edit", now = Date.now()) {
      if (!present) {
        present = snapshot;
        return;
      }
      if (snapshot.text === present.text) {
        // Selection-only change: remember where the caret is, no undo step.
        present = snapshot;
        return;
      }
      const coalesce = kind === lastKind && COALESCING.test(kind) && now - lastTime < groupMs;
      if (!coalesce) {
        undoStack.push(present);
        if (undoStack.length > limit) undoStack.shift();
      }
      redoStack = [];
      present = snapshot;
      lastKind = kind;
      lastTime = now;
    },

    undo() {
      if (!undoStack.length) return null;
      redoStack.push(present);
      present = undoStack.pop();
      lastKind = null;
      return present;
    },

    redo() {
      if (!redoStack.length) return null;
      undoStack.push(present);
      present = redoStack.pop();
      lastKind = null;
      return present;
    },

    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0
  };
}
