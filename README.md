# Townscape Lagoon

[Townscaper](https://store.steampowered.com/app/1291340/Townscaper/)（Oskar Stålberg）からエクスポートした `.obj` を、**ベイクなし**の専用シェーダで Townscaper らしい見た目のまま表示する [XRift](https://xrift.net/) ワールドです。

`meshStandardMaterial` に貼るだけでは Townscaper の見た目にならない（アルベドがノイズ状になる）ため、Townscaper の特殊な UV / テクスチャ構造を解釈する `ShaderMaterial` を実装しています。他のクリエイターが**自分の街を差し替えて**同じ見た目の XRift ワールドを作れる、最小構成のリファレンスも兼ねています。

## 何が実装されているか

| 要素 | 内容 |
|---|---|
| パレット合成 | UV の u 整数部 = ペイント色番号として `TownPalette.png` を引き、`TownColor.png` の **α** でディテール色と合成 |
| "every odd pixel is a line" | 64 セル格子をデコードして奇数テクセル（目地・罫線）を読む Townscaper 独自のテクスチャ手法 |
| material フラグ | `TownMaterial.png` の G チャンネルで窓明かり等を分岐 |
| トゥーン調ライティング | 非 PBR。ガンマ空間で 2 乗 → 拡散/バウンス/アンビエント → `sqrt` で戻す |
| 窓・ドア | Windows グループは壁に半埋めの「箱カッター」。**ステンシルパリティ**でくり抜き、凹んだ内面だけを描画（ベイク・CSG 不使用） |
| 水面 | 帯テクセルをスクロールする波紋（乗算合成）＋ Y 反転ミラーによる簡易反射 |
| グループ分岐 | OBJ の `g` グループ名（House / Water / Fencing / …）でマテリアルを振り分け |

技術的な背景は Reinder Nijhoff の記事に基づいています：
<https://reindernijhoff.net/2021/11/townscapers-rendering-style-in-webgl/>

## セットアップ

```bash
npm install
npm run dev        # http://localhost:5173 で確認
```

XRift へのアップロード：

```bash
npm install -g @xrift/cli
xrift login
xrift upload        # xrift.json から自動判定
```

その他のコマンド：`npm run build`（本番ビルド）/ `npm run typecheck`（型チェック）。

## 自分の Townscaper の街に差し替える

1. Townscaper 本体で街を開き、**Export OBJ**（`%USERPROFILE%\AppData\LocalLow\Oskar Stalberg\Townscaper\ObjExports\` などに出力される）。
2. 出力された `Town???.obj` と `TownColor.png` を、このリポジトリの `public/` に **`Town.obj` / `TownColor.png`** という名前でコピー。
3. `npm run dev` で確認。街の大きさが変わったら `src/World.tsx` のスポーン位置（`SpawnAnchor`）と `TOWN_SCALE` を調整。

### アセットについての注意

- **`Town.obj` / `TownColor.png`** … あなたの街ごとに変わる。上記手順で差し替える。
- **`TownPalette.png`（16×2px）/ `TownMaterial.png`（128×128px）** … Townscaper の描画に共通の "magic texture"。現行の OBJ エクスポートには含まれないため、Reinder Nijhoff の WebGL デモ由来のものを同梱しています。街を差し替えてもこの 2 枚はそのまま使えます。
- テクスチャは **無圧縮 PNG のまま**扱ってください。`NearestFilter`＋ミップマップ無効が前提で、basis/KTX2 圧縮やミップ生成をすると 128px アトラスの色が濁ります。
- GLB 変換で UV 量子化（Draco / meshopt / KHR_mesh_quantization）を掛けると、テクセル整列が壊れて罫線が消えます。**OBJ を直接読む**のが安全です。

## プロジェクト構成

```
public/                    Town.obj, TownColor.png, TownPalette.png, TownMaterial.png,
                           summer-toon-skybox.png, thumbnail.png
src/
  components/
    TownscaperTown/        OBJ読み込み + 専用シェーダ + ステンシル窓 + 水面 + コライダー
    SkyDome/               トゥーン調スカイボックス
  World.tsx                配置・ライティング・スポーン
  dev.tsx / index.tsx      開発用エントリ / 本番エクスポート
xrift.json                 XRift ワールド設定
```

## クレジット

- **Townscaper** — [Oskar Stålberg](https://oskarstalberg.com/Townscaper/)（3D モデル / テクスチャの著作権は原作者に帰属）
- **レンダリング手法・magic texture** — [Reinder Nijhoff](https://reindernijhoff.net/2021/11/townscapers-rendering-style-in-webgl/)
- **XRift 移植・シェーダ実装** — このリポジトリ

> Townscaper のモデル・テクスチャ資産の再配布・利用は原作者の規約に従ってください。本リポジトリのコード（シェーダ/コンポーネント）は MIT ライセンスです。

## ライセンス

MIT（`LICENSE` を参照）。同梱の Townscaper 由来アセットは上記クレジットの権利者に帰属します。
