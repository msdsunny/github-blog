function extractUrl(line) {
    // if the line already looks like a URL, just return it
    const trimmed = line.trim();
    if (/^https?:\/\//.test(trimmed)) return trimmed;
    // try to pull src from an <img> tag
    const match = trimmed.match(/src\s*=\s*"([^"]+)"/i);
    if (match) return match[1];
    // fallback: return original line (user may supply something else)
    return trimmed;
}

function generateHtml(rawLines) {
    const urls = rawLines
        .map(l => extractUrl(l))
        .filter(Boolean);
    return urls.map(u => `<div align="center"><img src="${u}"></div>`).join("\n");
}

function wrapImages(content) {
    // use DOM to wrap img elements so we don't accidentally wrap text
    const container = document.createElement('div');
    container.innerHTML = content;
    const imgs = container.querySelectorAll('img');
    imgs.forEach(img => {
        const parent = img.parentElement;
        if (parent && parent.tagName.toLowerCase() === 'div' && parent.getAttribute('align') === 'center') {
            // already wrapped; skip
            return;
        }
        const wrapper = document.createElement('div');
        wrapper.setAttribute('align', 'center');
        img.replaceWith(wrapper);
        wrapper.appendChild(img);
    });
    return container.innerHTML;
}

const inputArea = document.getElementById('url');
const outputArea = document.getElementById('output');
const previewArea = document.getElementById('preview');
const copyBtn = document.getElementById('copy');
const toggleOutputBtn = document.getElementById('toggle-output');

// map of relative image paths → blob URLs for preview rendering
const uploadedImageMap = new Map();
const toggleUploadBtn = document.getElementById('toggle-upload');
const uploadBlock = document.getElementById('upload-block');
const outputSection = document.getElementById('output-section');
// credential inputs for session storage
const repoInput = document.getElementById('repo');
const pathInput = document.getElementById('path');
const tokenInput = document.getElementById('token');

function looksLikeUrl(s) {
    // basic check for http(s) urls, data URIs, and relative paths (e.g., ../images/ or ./ or file.png)
    return /^(https?:\/\/|data:|blob:|\.\.?\/)/i.test(s) || /\.(png|jpe?g|gif|webp|svg|avif)(\?.*)?$/i.test(s);
}

function processContent(raw) {
    if (!raw.trim()) {
        outputArea.value = '';
        previewArea.innerHTML = '';
        copyBtn.disabled = true;
        return;
    }
    let result;
    if (/\<img\b/i.test(raw)) {
        // if there are img tags, check whether any have legitimate URL srcs
        const tmp = document.createElement('div');
        tmp.innerHTML = raw;
        const imgs = tmp.querySelectorAll('img');
        const hasValidUrl = Array.from(imgs).some(i => looksLikeUrl(i.getAttribute('src') || ''));

        if (hasValidUrl) {
            // wrap images with valid URLs
            result = wrapImages(raw);
        } else {
            // no valid URLs found - remove non-URL img tags and divs
            const cleaned = tmp.cloneNode(true);
            const badImgs = Array.from(cleaned.querySelectorAll('img')).filter(i => !looksLikeUrl(i.getAttribute('src') || ''));
            badImgs.forEach(img => {
                const parent = img.parentElement;
                // if wrapped in <div align="center">, remove the wrapper
                if (parent && parent.tagName.toLowerCase() === 'div' && parent.getAttribute('align') === 'center') {
                    parent.remove();
                } else {
                    img.remove();
                }
            });
            result = cleaned.innerHTML.trim();
        }
    } else {
        const lines = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        if (lines.length > 0 && lines.every(looksLikeUrl)) {
            // treat as URL list
            result = generateHtml(lines);
        } else {
            // leave arbitrary text alone (maybe blog content without <img>)
            result = raw;
        }
    }
    outputArea.value = result;
    // for preview, swap relative image paths with blob URLs so images display
    let previewResult = result;
    for (const [relativePath, blobUrl] of uploadedImageMap) {
        previewResult = previewResult.replaceAll(relativePath, blobUrl);
    }
    // render markdown in preview, fall back to raw HTML
    try {
        previewArea.innerHTML = marked.parse(previewResult);
    } catch (e) {
        previewArea.innerHTML = previewResult;
    }
    copyBtn.disabled = result === '';
}

// debounced save to localStorage
let saveTimer = null;
function debouncedSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        localStorage.setItem('inputContent', inputArea.value);
    }, 500);
}

// fire on input change: update preview instantly, save to storage with debounce
inputArea.addEventListener('input', () => {
    processContent(inputArea.value);
    debouncedSave();
});


// read an image file handle and return a data-URI string
async function fileHandleToDataUri(fileHandle) {
    const file = await fileHandle.getFile();
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

// search for a file by name recursively within a directory handle
async function searchFileByName(dirHandle, targetFileName) {
    try {
        for await (const [name, handle] of dirHandle.entries()) {
            if (handle.kind === 'file' && name === targetFileName) {
                return handle;
            }
            if (handle.kind === 'directory') {
                const result = await searchFileByName(handle, targetFileName);
                if (result) return result;
            }
        }
    } catch {
        // permission error or similar
    }
    return null;
}

// extract a usable path from various image reference formats
function normalizeImagePath(rawPath) {
    let cleaned = rawPath.trim();
    // strip file:/// protocol
    if (cleaned.startsWith('file:///')) {
        cleaned = cleaned.slice(7); // removes "file:///"
    }
    // decode URI encoding (%20, etc.)
    try { cleaned = decodeURIComponent(cleaned); } catch { }
    return cleaned;
}

// given markdown text and access to a root directory handle + the subdirectory
// the .md file lives in, resolve every image reference to a data URI.
async function resolveImages(markdown, rootDirHandle, mdDirParts) {
    // match both ![alt](path) and <img ... src="path" ...>
    const imgRegex = /!\[[^\]]*\]\(([^)]+)\)|<img[^>]+src\s*=\s*"([^"]+)"/gi;
    const replacements = [];
    // cache already-searched filenames to avoid duplicate searches
    const searchCache = new Map();
    let m;
    while ((m = imgRegex.exec(markdown)) !== null) {
        const rawPath = m[1] || m[2];
        // skip web URLs and data URIs
        if (/^(https?:\/\/|data:)/i.test(rawPath)) continue;

        const cleanPath = normalizeImagePath(rawPath);
        const fileName = cleanPath.split('/').pop();
        let fileHandle = null;

        if (cleanPath.startsWith('/') || rawPath.startsWith('file:///')) {
            // ABSOLUTE path or file:// URI — can't resolve by walking from root
            // since we don't know the root's absolute path.
            // Strategy: search by filename in the entire directory tree.
            if (searchCache.has(fileName)) {
                fileHandle = searchCache.get(fileName);
            } else {
                fileHandle = await searchFileByName(rootDirHandle, fileName);
                searchCache.set(fileName, fileHandle);
            }
        } else {
            // RELATIVE path — resolve from the md file's directory
            const combined = [...mdDirParts];
            const relParts = cleanPath.split('/');
            for (const p of relParts) {
                if (p === '.' || p === '') continue;
                if (p === '..') { combined.pop(); continue; }
                combined.push(p);
            }
            // try to walk directory tree from root
            try {
                let handle = rootDirHandle;
                for (let i = 0; i < combined.length; i++) {
                    if (i === combined.length - 1) {
                        handle = await handle.getFileHandle(combined[i]);
                    } else {
                        handle = await handle.getDirectoryHandle(combined[i]);
                    }
                }
                fileHandle = handle;
            } catch {
                // relative resolution failed — fallback to filename search
                if (searchCache.has(fileName)) {
                    fileHandle = searchCache.get(fileName);
                } else {
                    fileHandle = await searchFileByName(rootDirHandle, fileName);
                    searchCache.set(fileName, fileHandle);
                }
            }
        }

        if (fileHandle) {
            try {
                const dataUri = await fileHandleToDataUri(fileHandle);
                replacements.push({ original: rawPath, dataUri });
            } catch {
                console.warn('Could not read image file:', rawPath);
            }
        } else {
            console.warn('Could not find image:', rawPath);
        }
    }
    // apply replacements (replace all occurrences of each path)
    let result = markdown;
    for (const { original, dataUri } of replacements) {
        // escape for use in regex
        const escaped = original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        result = result.replace(new RegExp(escaped, 'g'), dataUri);
    }
    return result;
}

// open file button — use File System Access API when available
const fileInput = document.getElementById('file-input');

// cache directory handle so user only picks root dir once per session
let cachedRootDirHandle = null;

document.getElementById('open-file').addEventListener('click', async () => {
    if (window.showOpenFilePicker) {
        try {
            const [fileHandle] = await window.showOpenFilePicker({
                types: [{
                    description: 'Markdown files',
                    accept: { 'text/markdown': ['.md', '.markdown', '.txt'] }
                }],
                multiple: false,
            });
            const file = await fileHandle.getFile();
            let content = await file.text();

            // check if the content has ANY local image references:
            // - relative paths (../images/foo.png)
            // - absolute paths (/home/user/images/foo.png)
            // - file:/// URIs (file:///home/user/images/foo.png)
            const hasLocalImages = /!\[[^\]]*\]\((?!https?:\/\/|data:)([^)]+)\)|<img[^>]+src\s*=\s*"(?!https?:\/\/|data:)([^"]+)"/i.test(content);

            if (hasLocalImages) {
                // Ask for directory access if we don't have one cached
                if (!cachedRootDirHandle) {
                    try {
                        alert('This file has local image references.\nPlease select the ROOT folder that contains both your markdown files and images folders.\n\nFor example, if your images are in ~/Desktop/images/, select your Desktop folder.');
                        cachedRootDirHandle = await window.showDirectoryPicker({
                            mode: 'read',
                            startIn: 'desktop',
                        });
                    } catch {
                        // user cancelled — still load the file, images just won't resolve
                    }
                }

                if (cachedRootDirHandle) {
                    const pathParts = await findFileInDirectory(cachedRootDirHandle, file.name);
                    if (pathParts) {
                        const dirParts = pathParts.slice(0, -1);
                        content = await resolveImages(content, cachedRootDirHandle, dirParts);
                    } else {
                        content = await resolveImages(content, cachedRootDirHandle, []);
                    }
                }
            }

            inputArea.value = content;
            processContent(inputArea.value);
            debouncedSave();
        } catch (err) {
            if (err.name !== 'AbortError') console.error('File open error:', err);
        }
    } else {
        // fallback for browsers without File System Access API
        fileInput.click();
    }
});

// find a file by name inside a directory handle, returns array of path parts
async function findFileInDirectory(dirHandle, fileName, currentPath = []) {
    try {
        for await (const [name, handle] of dirHandle.entries()) {
            if (handle.kind === 'file' && name === fileName) {
                return [...currentPath, name];
            }
            if (handle.kind === 'directory') {
                const result = await findFileInDirectory(handle, fileName, [...currentPath, name]);
                if (result) return result;
            }
        }
    } catch {
        // permission error or similar
    }
    return null;
}

fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
        inputArea.value = reader.result;
        processContent(inputArea.value);
        debouncedSave();
    };
    reader.readAsText(file);
    // reset so the same file can be re-selected
    fileInput.value = '';
});

toggleUploadBtn.addEventListener('click', () => {
    uploadBlock.classList.toggle('active');
});

toggleOutputBtn.addEventListener('click', () => {
    const isVisible = outputSection.style.display !== 'none';
    outputSection.style.display = isVisible ? 'none' : 'flex';
    toggleOutputBtn.textContent = isVisible ? 'Output' : 'Hide Output';
});

// persist credentials in sessionStorage
function saveCreds() {
    sessionStorage.setItem('githubRepo', repoInput.value);
    sessionStorage.setItem('githubPath', pathInput.value);
    sessionStorage.setItem('githubToken', tokenInput.value);
}

// if the fields exist, hook up persistence
if (repoInput) repoInput.addEventListener('input', saveCreds);
if (pathInput) pathInput.addEventListener('input', saveCreds);
if (tokenInput) tokenInput.addEventListener('input', saveCreds);

// restore on load
window.addEventListener('load', () => {
    if (sessionStorage.getItem('githubRepo')) repoInput.value = sessionStorage.getItem('githubRepo');
    if (sessionStorage.getItem('githubPath')) pathInput.value = sessionStorage.getItem('githubPath');
    if (sessionStorage.getItem('githubToken')) tokenInput.value = sessionStorage.getItem('githubToken');
    // restore input content from localStorage
    const saved = localStorage.getItem('inputContent');
    if (saved) {
        inputArea.value = saved;
        processContent(saved);
    }
});

document.getElementById('copy').addEventListener('click', () => {
    outputArea.select();
    outputArea.setSelectionRange(0, 99999); /* for mobile */
    document.execCommand('copy');
    alert('Copied to clipboard!');
});

document.getElementById('copy').addEventListener('click', () => {
    const output = document.getElementById('output');
    output.select();
    output.setSelectionRange(0, 99999); /* for mobile */
    document.execCommand('copy');
    alert('Copied to clipboard!');
});

// ------ upload section --------------------------------------------------
const dropzone = document.getElementById('dropzone');
const status = document.getElementById('upload-status');

function showStatus(msg, isError) {
    status.textContent = msg;
    status.style.color = isError ? 'red' : '#333';
}

function uploadImage(blob) {
    return new Promise((resolve, reject) => {
        let repoInput = document.getElementById('repo').value.trim();
        const path = document.getElementById('path').value.trim() || '';
        const token = document.getElementById('token').value.trim();
        if (!repoInput || !token) {
            showStatus('Repository and token are required', true);
            reject('missing repo/token');
            return;
        }
        // handle full GitHub URL
        if (repoInput.startsWith('https://github.com/')) {
            const parts = repoInput.split('/').slice(3, 5);
            if (parts.length === 2) {
                repoInput = parts.join('/');
            } else {
                showStatus('Invalid GitHub URL format', true);
                reject('bad url');
                return;
            }
        }
        // validate owner/repo format
        const repoParts = repoInput.split('/');
        if (repoParts.length !== 2 || !repoParts[0] || !repoParts[1]) {
            showStatus('Repo must be in owner/repo format (or full GitHub URL)', true);
            reject('bad repo');
            return;
        }
        const [owner, repository] = repoParts;
        // Determine file extension from blob type so SVGs get saved as .svg
        const extMap = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' };
        const ext = extMap[blob.type] || 'png';
        const filename = `image-${Date.now()}.${ext}`;
        const fullPath = path ? `${path.replace(/\/+$/, '')}/${filename}` : filename;

        const reader = new FileReader();
        reader.onload = () => {
            const b64 = reader.result.split(',')[1];
            const url = `https://api.github.com/repos/${owner}/${repository}/contents/${fullPath}`;
            fetch(url, {
                method: 'PUT',
                headers: {
                    Authorization: `token ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    message: 'Upload via helper',
                    content: b64
                })
            }).then(r => r.json())
                .then(data => {
                    if (data && data.content) {
                        showStatus('Upload successful');
                        // Use a relative path for the markdown
                        // But we also need the temporary download_url for the preview
                        resolve({
                            relativePath: `../${fullPath}`,
                            githubUrl: data.content.download_url
                        });
                    } else {
                        showStatus('Upload failed', true);
                        console.error('upload error', data);
                        reject(data);
                    }
                }).catch(err => {
                    showStatus('Upload error', true);
                    console.error(err);
                    reject(err);
                });
        };
        reader.readAsDataURL(blob);
    });
}

// ------ Upload URLs from content -----------------------------------------

// Download an image from a URL via local proxy (server-side fetch, no CORS issues)
// Falls back to direct fetch if proxy isn't available
async function downloadImageAsBlob(url) {
    // Try via local proxy first (handles CORS by fetching server-side)
    try {
        const proxyUrl = `http://localhost:3000/download-image?url=${encodeURIComponent(url)}`;
        const resp = await fetch(proxyUrl);
        if (resp.ok) {
            return await resp.blob();
        }
    } catch (err) {
        console.warn('Local proxy not available, trying direct fetch...', err.message);
    }

    // Fallback: direct fetch (works if served from same origin or CORS allowed)
    try {
        const resp = await fetch(url);
        if (resp.ok) {
            return await resp.blob();
        }
    } catch (err) {
        console.error('Direct fetch also failed:', url, err.message);
    }
    return null;
}

// Check if a URL is a valid image URL we should process
function isImageUrl(url) {
    // known image extensions
    if (/\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)(\?.*)?$/i.test(url)) return true;
    // educative.io image API or similar image API endpoints
    if (/\/image\/\d+/i.test(url)) return true;
    // URLs with common image-related query params
    if (/[?&](image|img|photo|pic|get_optimised)/i.test(url)) return true;
    return false;
}

// Main function: scan content for image URLs, download & upload to GitHub,
// replace original URLs with GitHub URLs wrapped in centered div
async function uploadUrlsFromContent() {
    const content = inputArea.value;
    if (!content.trim()) {
        showStatus('No content to scan', true);
        return;
    }

    // Step 1: Remove SVG data URI placeholder images ![](data:image/svg+xml,...)
    // These are dummy placeholders paired with real images
    let cleanedContent = content.replace(/!\[\]\(data:image\/svg\+xml[^)]*\)/g, '');

    // Step 2: Find all markdown image references with HTTP URLs: ![...](https://...)
    // Capture the full match and the URL inside
    const mdImageRegex = /!\[[^\]]*\]\((https?:\/\/[^\s)"]+)(?:\s[^)]*)??\)/g;
    const matches = [];
    let m;
    while ((m = mdImageRegex.exec(cleanedContent)) !== null) {
        const url = m[1].trim();
        if (isImageUrl(url)) {
            matches.push({
                fullMatch: m[0],    // e.g. ![](https://educative.io/api/.../image/123?...)
                url: url            // just the URL
            });
        }
    }

    if (matches.length === 0) {
        // Also check for bare URLs (not in markdown syntax)
        const bareUrlRegex = /https?:\/\/[^\s<>"']+/gi;
        const bareMatches = (cleanedContent.match(bareUrlRegex) || []).filter(isImageUrl);
        if (bareMatches.length === 0) {
            showStatus('No image URLs found in content', true);
            return;
        }
        // Use bare URLs
        for (const url of bareMatches) {
            matches.push({ fullMatch: url, url: url });
        }
    }

    // Deduplicate by URL
    const seen = new Set();
    const uniqueMatches = matches.filter(m => {
        if (seen.has(m.url)) return false;
        seen.add(m.url);
        return true;
    });

    const uploadUrlBtn = document.getElementById('upload-urls');
    uploadUrlBtn.disabled = true;
    uploadUrlBtn.textContent = `Uploading 0/${uniqueMatches.length}...`;
    showStatus(`Found ${uniqueMatches.length} image URL(s). Downloading & uploading...`);

    let updatedContent = cleanedContent;
    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < uniqueMatches.length; i++) {
        const { fullMatch, url } = uniqueMatches[i];
        uploadUrlBtn.textContent = `Uploading ${i + 1}/${uniqueMatches.length}...`;
        showStatus(`Processing ${i + 1}/${uniqueMatches.length}: downloading...`);

        try {
            const blob = await downloadImageAsBlob(url);
            if (!blob) {
                console.warn('Could not download:', url);
                failCount++;
                continue;
            }

            showStatus(`Processing ${i + 1}/${uniqueMatches.length}: uploading to GitHub...`);
            const { relativePath, githubUrl } = await uploadImage(blob);

            if (!githubUrl || !relativePath) {
                failCount++;
                continue;
            }

            // Build the wrapped replacement using relative path for the markdown
            const wrappedSnippet = `<div align="center"><img src="${relativePath}" /></div>`;

            // Replace ALL occurrences of the full match in the content
            updatedContent = updatedContent.split(fullMatch).join(wrappedSnippet);

            // Store mapping so the preview pane shows the actual GitHub image
            uploadedImageMap.set(relativePath, githubUrl);

            successCount++;
            // Small delay to avoid hitting GitHub rate limits
            if (i < uniqueMatches.length - 1) {
                await new Promise(r => setTimeout(r, 500));
            }
        } catch (err) {
            console.error('Failed to process URL:', url, err);
            failCount++;
        }
    }

    // Update the input area with the new content
    inputArea.value = updatedContent;
    processContent(updatedContent);
    debouncedSave();

    uploadUrlBtn.disabled = false;
    uploadUrlBtn.textContent = 'Upload URLs';
    showStatus(`Done! ${successCount} uploaded, ${failCount} failed.`, failCount > 0);
}

// Hook up button
document.getElementById('upload-urls').addEventListener('click', uploadUrlsFromContent);

function insertSnippet(url) {
    const snippet = `<div align="center"><img src="${url}" /></div>`;
    const textarea = inputArea;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const before = textarea.value.slice(0, start);
    const after = textarea.value.slice(end);
    textarea.value = before + snippet + after;
    const pos = start + snippet.length;
    textarea.selectionStart = textarea.selectionEnd = pos;
    processContent(textarea.value);
}

function handleFiles(files) {
    for (const file of files) {
        if (file.type.startsWith('image/')) {
            uploadImage(file).then(({ relativePath, githubUrl }) => {
                // store mapping so preview can show the temporary github image
                if (githubUrl) {
                    uploadedImageMap.set(relativePath, githubUrl);
                }
                insertSnippet(relativePath);
            });
        }
    }
}

// drag/drop on modal dropzone
['dragenter', 'dragover'].forEach(evt => {
    dropzone.addEventListener(evt, e => {
        e.preventDefault();
        dropzone.classList.add('dragover');
        // ensure modal open
        uploadBlock.classList.add('active');
    });
});
['dragleave', 'drop'].forEach(evt => {
    dropzone.addEventListener(evt, e => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
    });
});
dropzone.addEventListener('drop', e => {
    e.preventDefault();
    uploadBlock.classList.add('active');
    handleFiles(e.dataTransfer.files);
});

// initialise Turndown HTML-to-Markdown converter
const turndownService = new TurndownService({
    headingStyle: 'atx',        // # style headings
    codeBlockStyle: 'fenced',   // ``` style code blocks
    bulletListMarker: '-',
    emDelimiter: '*',
    strongDelimiter: '**',
    linkStyle: 'inlined',
});
// enable GFM extras (tables, strikethrough, task lists)
turndownService.use(turndownPluginGfm.gfm);

// paste into input area — convert rich HTML to markdown
inputArea.addEventListener('paste', e => {
    const clipboardData = e.clipboardData;
    if (!clipboardData) return;

    // 1. check for image paste first (existing upload behaviour)
    const items = clipboardData.items;
    if (items) {
        for (const item of items) {
            if (item.type.startsWith('image/')) {
                e.preventDefault();
                const blob = item.getAsFile();
                uploadImage(blob).then(({ relativePath, githubUrl }) => {
                    if (githubUrl) {
                        uploadedImageMap.set(relativePath, githubUrl);
                    }
                    insertSnippet(relativePath);
                });
                return;
            }
        }
    }

    // 2. check for rich HTML content and convert to markdown
    const html = clipboardData.getData('text/html');
    if (html && html.trim()) {
        const types = Array.from(clipboardData.types || []);
        const isVSCode = types.includes('vscode-editor-data');
        
        // Check if the HTML contains structural tags that imply actual rich text
        // (paragraphs, headings, lists, tables, links, bold, italic, quotes, etc.)
        // If it's just <div>s and <span>s (like IDE syntax highlighting), we skip Turndown.
        const hasRichMarkup = /<(p|h[1-6]|ul|ol|li|table|blockquote|a|strong|b|em|i)\b/i.test(html);

        if (isVSCode || !hasRichMarkup) {
            // It's likely syntax-highlighted code from an editor.
            // Turndown strips indentation from this.
            // Return early to let the browser's default paste handle text/plain natively,
            // which preserves perfect indentation.
            return;
        }

        e.preventDefault();
        const markdown = turndownService.turndown(html);
        // insert at cursor position
        const start = inputArea.selectionStart;
        const end = inputArea.selectionEnd;
        const before = inputArea.value.slice(0, start);
        const after = inputArea.value.slice(end);
        inputArea.value = before + markdown + after;
        // move cursor to end of inserted text
        const pos = start + markdown.length;
        inputArea.selectionStart = inputArea.selectionEnd = pos;
        // trigger processing and save
        processContent(inputArea.value);
        debouncedSave();
    }
});

// drop onto input area
inputArea.addEventListener('dragover', e => e.preventDefault());
inputArea.addEventListener('drop', e => {
    e.preventDefault();
    if (e.dataTransfer && e.dataTransfer.files) {
        handleFiles(e.dataTransfer.files);
    }
});
