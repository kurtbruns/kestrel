// Handing the reader a file the page made or fetched: a text becomes a download under a
// name, through a short-lived object URL, since the API's files need the credential a plain
// link can't carry.

/** Save `text` as a file named `filename`, of the given media type. */
export function saveFile(text: string, filename: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  // Long enough for the browser to start the download before the URL goes.
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
