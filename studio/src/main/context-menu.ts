// Right-click a red squiggle and get the word spelled properly.
//
// Chromium has been underlining misspellings in every textarea in Studio all
// along; what it does not do on its own is offer the fix. The suggestions
// arrive attached to the context-menu event and are dropped on the floor
// unless something builds a menu out of them, so the squiggle was a report
// with no remedy (2026-10-28).
//
// The dictionary belongs to the session, so "add to dictionary" survives a
// restart. That matters more here than in most apps: a good share of this
// course's vocabulary (Glitch, Kokoro, Riverdale, subquery) is in no en-US
// word list, and an underline under every one of them trains the eye to stop
// seeing underlines.
import { Menu, BrowserWindow, type MenuItemConstructorOptions } from "electron";

export function installContextMenu(win: BrowserWindow) {
  // American English, including the squiggles. Left alone, Chromium follows
  // the system locale, and a machine set to en-GB would underline exactly the
  // spellings the scripts are required to use.
  try { win.webContents.session.setSpellCheckerLanguages(["en-US"]); } catch { /* no dictionary available; the menu still works without one */ }

  win.webContents.on("context-menu", (_e, p) => {
    const items: MenuItemConstructorOptions[] = [];
    const word = p.misspelledWord;
    if (word) {
      // Eight is as many as stays readable. Chromium rarely returns more.
      const suggestions = p.dictionarySuggestions.slice(0, 8);
      for (const s of suggestions) items.push({ label: s, click: () => win.webContents.replaceMisspelling(s) });
      if (!suggestions.length) items.push({ label: "No suggestions", enabled: false });
      items.push({ type: "separator" }, { label: `Add "${word}" to dictionary`, click: () => win.webContents.session.addWordToSpellCheckerDictionary(word) }, { type: "separator" });
    }
    if (p.isEditable) items.push({ role: "cut", enabled: p.editFlags.canCut }, { role: "copy", enabled: p.editFlags.canCopy }, { role: "paste", enabled: p.editFlags.canPaste }, { type: "separator" }, { role: "selectAll" });
    else if (p.selectionText.trim()) items.push({ role: "copy" });
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });
}
