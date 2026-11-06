# ArchBoard

モデルを「正」にした、編集できる建築プレゼンボード（Phase 0）

- Blender で書き出したモデルを、**形状を一切変えずに**使います
- 文字・矢印・寸法は**部材に固定**され、視点を変えても正しい場所を指します
- 寸法値はモデルから自動計算され、手で書き換えられません
- モデルを修正すると、**どの部材が変わったか**を自動で示します
- A3 用紙座標の SVG で注釈を描くため、書き出した SVG の文字は後から編集できます

## すぐに使う

| ファイル | 内容 |
|---|---|
| [`dist/ArchBoard.html`](dist/ArchBoard.html) | アプリ本体。ダウンロードして Chrome / Edge で開くだけ（インストール・ネット接続不要） |
| [`dist/archboard_exporter-0.1.0.zip`](dist/archboard_exporter-0.1.0.zip) | Blender アドオン（Blender 4.2 以降、5.2 で動作確認） |
| [`sample/`](sample/) | 架空のサンプル住宅（.blend と書き出し済みデータ） |
| [`docs/使い方.txt`](docs/使い方.txt) | 使い方・命名ルール・設計変更時の流れ |

## 仕組み

```
Cinema 4D ──FBX──▶ Blender ──アドオン──▶ model.glb + manifest.json
                                              │（カメラ・部材一覧・形状ハッシュ）
                                              ▼
                                   ArchBoard.html（ブラウザ）
                                              │  project.json に保存
                                              ▼
                          A3 PNG / 編集可能 SVG / Photoshop 用レイヤー
```

## フォルダ構成

```
app/      アプリのソースコード（Three.js + Vite）
addon/    Blender アドオンのソースコード
dist/     完成品（そのまま使えるファイル）
sample/   架空のサンプルモデル
docs/     説明書
```

## アプリを作り直す場合（開発者向け）

```
cd app
npm install
npx vite build      # → app/dist/index.html が 1 ファイルで出力される
```

## ロードマップ

- [x] Phase 0：技術検証（3D 表示・部材アンカー注釈・形状ロック・差分検出・書き出し）
- [ ] Phase 1：A3 冊子（ページ編集・テンプレート・複数ページ PDF）
- [ ] Phase 2：Blender レンダー連携・線画スタイル
- [ ] Phase 3：モニター説明モード
- [ ] Phase 4：動画素材書き出し（DaVinci Resolve 用）
- [ ] Phase 5：ローカル AI（任意）
