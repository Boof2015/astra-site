// A small suggestion dropdown attached to a text input (language fields now, artist typeahead
// later). The caller supplies the items and what picking one does; this owns the list, the
// keyboard (↑/↓, Enter/Tab to pick, Esc to close) and mouse picking without stealing focus.
//
// getItems(input) -> [{ html, ...anything }]  (html must already be escaped)
// onPick(item, input)
// openOnFocus: show the list on focus, not just while typing

export function attachSuggest(input, { getItems, onPick, openOnFocus = false }) {
  const host = input.parentElement;
  host.classList.add("suggest-host");
  const list = document.createElement("div");
  list.className = "suggest-list";
  list.setAttribute("role", "listbox");
  list.id = `${input.id || "suggest"}-list`;
  host.appendChild(list);
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", list.id);
  input.setAttribute("autocomplete", "off");

  let items = [];
  let active = -1;
  let open = false;
  let picking = false;

  function render() {
    items = getItems(input) || [];
    active = items.length ? 0 : -1;
    if (!items.length) {
      close();
      return;
    }
    list.innerHTML = items.map((item, i) => (
      `<div class="suggest-item${i === active ? " active" : ""}" role="option" data-i="${i}">${item.html}</div>`
    )).join("");
    list.classList.add("show");
    open = true;
    input.setAttribute("aria-expanded", "true");
  }

  function close() {
    list.classList.remove("show");
    list.innerHTML = "";
    open = false;
    active = -1;
    input.setAttribute("aria-expanded", "false");
  }

  function setActive(i) {
    active = (i + items.length) % items.length;
    [...list.children].forEach((node, n) => node.classList.toggle("active", n === active));
    list.children[active]?.scrollIntoView({ block: "nearest" });
  }

  function pick(i) {
    const item = items[i];
    close();
    if (!item) return;
    // onPick usually dispatches "input" so the owner reacts; don't reopen the list for it.
    picking = true;
    try {
      onPick(item, input);
    } finally {
      picking = false;
    }
  }

  const onInput = () => {
    if (!picking) render();
  };
  const onFocus = () => {
    if (openOnFocus) render();
  };
  const onBlur = () => close();
  const onKeydown = (e) => {
    if (!open) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        render();
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive(active + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(active - 1);
    } else if (e.key === "Enter" || (e.key === "Tab" && !e.shiftKey)) {
      if (active < 0) return;
      e.preventDefault();
      pick(active);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };
  // mousedown (not click) so the input keeps focus and blur doesn't close the list first.
  const onListDown = (e) => {
    const node = e.target.closest(".suggest-item");
    if (!node) return;
    e.preventDefault();
    pick(Number(node.dataset.i));
  };

  input.addEventListener("input", onInput);
  input.addEventListener("focus", onFocus);
  input.addEventListener("blur", onBlur);
  input.addEventListener("keydown", onKeydown);
  list.addEventListener("mousedown", onListDown);

  return {
    refresh: render,
    close,
    destroy() {
      input.removeEventListener("input", onInput);
      input.removeEventListener("focus", onFocus);
      input.removeEventListener("blur", onBlur);
      input.removeEventListener("keydown", onKeydown);
      list.removeEventListener("mousedown", onListDown);
      list.remove();
    }
  };
}
