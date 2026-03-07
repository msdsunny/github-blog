# GitHub Image HTML Generator

A tiny helper application that takes a GitHub image URL (the one you get when you paste a screenshot into a Markdown file) and returns the HTML snippet with a centered `img` tag:

```html
<div align="center"><img src="https://..." /></div>
```

## Usage

2. The interface is now a clean, two-column layout (stacks to one column on mobile) inspired by modern editors like StackEdit:
   * **Top toolbar** with Generate, Copy, Output toggle, and Upload buttons.
   * **Two columns**: Input (left), Preview (right).
   * Clicking **Output** toggles the visibility of the Output section below the columns.
   * Clicking **Upload** opens a modal for repo/token settings and a drag/paste target.
3. **Upload & paste integration** – you can now paste or drop an image directly **into the main editor area**. When an image is detected the tool automatically uploads it to the configured GitHub repository and inserts a centered `<img>` snippet at the cursor position. You only need to open the upload panel once to enter the repo (in `owner/repo` format or full GitHub URL like `https://github.com/owner/repo`), optional path, and a personal access token; thereafter the editor will continue to use those values. Those credentials are kept in `sessionStorage` so they persist while the page is open and are restored after a refresh.

   **Token setup:** Create a personal access token at [GitHub Settings > Developer settings > Personal access tokens](https://github.com/settings/tokens). For private repos, select the `repo` scope; for public repos, `public_repo` is sufficient. The token needs write access to the repository.
4. **Input** – you may still manually type or paste URLs, full `<img>` tags, or entire HTML/blog content. The generator wraps images or creates centered snippets as before.
5. A live preview updates as you type; **Generate** recomputes on demand. Output appears in the box at the bottom.
6. Use **Copy** to grab the output once it’s ready, then paste into your Markdown or post.

You can also adapt the little script for the command line if you prefer:

```js
// quick-cli.js
const url = process.argv[2];
if (!url) {
  console.error('Usage: node quick-cli.js <image-url>');
  process.exit(1);
}
console.log(`<div align="center"><img src="${url}"></div>`);
```
