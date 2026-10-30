/**
 * Has the browser download `file` as `name`, as a link to it would: saved
 * where downloads go, or asked where, as the user has their browser set.
 */
export function download(file: Blob, name: string) {
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  // The download has the file from the click on: the URL only kept it in memory.
  setTimeout(() => URL.revokeObjectURL(url));
}
