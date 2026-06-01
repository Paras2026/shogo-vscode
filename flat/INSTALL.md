# Shogo Chat VS Code extension — install

This is split across TWO secret gists (GitHub gists can't hold subfolders, so `/` is encoded as `__`).

## Files
- **Gist 1** (id 75b45092d9398b47247a287ccf45abd2): package.json, tsconfig.json, esbuild.js, unpack.sh, src__extension.ts, src__auth.ts, src__context.ts
- **Gist 2** (this one): src__ShogoViewProvider.ts, src__shogoClient.ts, media__main.js, media__main.css, media__icon.svg, dotvscode__launch.json, dotvscode__tasks.json, gitignore.txt, vscodeignore.txt

## Steps
```bash
# 1. Clone both gists into one folder
git clone https://gist.github.com/75b45092d9398b47247a287ccf45abd2.git part1
git clone <THIS_GIST_GIT_URL> part2
mkdir -p flat && cp part1/* flat/ && cp part2/* flat/
cd flat

# 2. Rebuild folder structure
mkdir -p shogo-vscode/src shogo-vscode/media shogo-vscode/.vscode
for f in *; do
  case "$f" in unpack.sh|README.md|INSTALL.md) continue;; esac
  name=$(echo "$f" | sed -e 's|dotvscode__|.vscode/|' -e 's|__|/|g')
  case "$f" in gitignore.txt) name=.gitignore;; vscodeignore.txt) name=.vscodeignore;; esac
  dest="shogo-vscode/$name"; mkdir -p "$(dirname "$dest")"; cp "$f" "$dest"
done

# 3. Build + install
cd shogo-vscode
npm install
npm run package
code --install-extension shogo-vscode-0.0.1.vsix
```

Then: Shogo icon in Activity Bar -> Set API Key -> paste shogo_sk_ key -> chat.
