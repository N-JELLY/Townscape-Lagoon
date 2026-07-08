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

その他のコマンド：`npm run build`（本番ビルド）/ `npm run typecheck`（型チェック）。

XRift へのログイン・アップロード手順は [XRift 公式ドキュメント](https://docs.xrift.net/) を参照してください。ワールドのタイトル・説明・サムネイルは `xrift.json` の `world.title` / `world.description` / `world.thumbnailPath` で定義します。

## 自分の Townscaper の街に差し替える

1. Townscaper 本体で街を開き、**Export OBJ**（`%USERPROFILE%\AppData\LocalLow\Oskar Stalberg\Townscaper\ObjExports\` などに出力される）。
2. 出力された `Town???.obj` と `TownColor.png` を、このリポジトリの `public/` に **`Town.obj` / `TownColor.png`** という名前でコピー。
3. `npm run dev` で確認。街の大きさが変わったら `src/World.tsx` のスポーン位置（`SpawnAnchor`）と `TOWN_SCALE` を調整。

### アセットについての注意

- **`Town.obj` / `TownColor.png`** … あなたの街ごとに変わる。上記手順で差し替える。
- **`TownPalette.png`（16×2px）/ `TownMaterial.png`（128×128px）** … Townscaper の描画に共通の "magic texture"。現行の OBJ エクスポートには含まれないため、Reinder Nijhoff の WebGL デモ由来のものを同梱しています。街を差し替えてもこの 2 枚はそのまま使えます。
- テクスチャは **無圧縮 PNG のまま**扱ってください。`NearestFilter`＋ミップマップ無効が前提で、basis/KTX2 圧縮やミップ生成をすると 128px アトラスの色が濁ります。
- GLB 変換で UV 量子化（Draco / meshopt / KHR_mesh_quantization）を掛けると、テクセル整列が壊れて罫線が消えます。**OBJ を直接読む**のが安全です。

他の Townscaper ワールドを作る時に最低限差し替えるものは、通常 `public/Town.obj`、`public/TownColor.png`、`public/thumbnail.png`、必要なら環境音ファイルです。ワールド名・説明は `xrift.json`、スポーン位置は `src/World.tsx` の `SpawnAnchor` を調整してください。

## 環境音を鳴らす

`AmbientAudio` コンポーネントが `public/` の以下のファイルを自動でループ再生します。ファイルが無い場合は警告のみで、ワールドは通常どおり動きます。

| ファイル名 | 内容 | 音量の調整点 |
|---|---|---|
| `public/852826__kkenny101__gentle-ocean-waves-loop.wav` | 波・水辺の環境音ループ | `World.tsx` の `AmbientAudio volume` |

別の音源に差し替える場合は、同名ファイルを置き換えるか、`src/World.tsx` の `<AmbientAudio file="..." />` を変更してください。

### 音源の入手先の例

- [効果音ラボ](https://soundeffect-lab.info/) … 商用可・クレジット不要。「波」「海」「カモメ」等で検索
- [OtoLogic](https://otologic.jp/) … CC BY 4.0（クレジット表記で利用可）
- [freesound](https://freesound.org/) … ライセンスを **CC0** で絞り込んで検索（"ocean waves loop" / "seagulls"）

### 音源を用意するときのコツ

- **ループ前提の素材**を選ぶか、[Audacity](https://www.audacityteam.org/) 等で端をクロスフェードしてループの継ぎ目を消す
- 長さは 30 秒〜1 分程度あると繰り返しが気になりにくい
- 配信サイズを抑える場合は MP3 / Ogg へ変換しても構いません。その場合は `AmbientAudio file` も合わせて変更してください
- ライセンス（商用可か・クレジット要否）を必ず確認し、必要なら README に表記を追加する

## プロジェクト構成

```
public/                    Town.obj, TownColor.png, TownPalette.png, TownMaterial.png,
                           summer-toon-skybox.png, thumbnail.png
                           852826__kkenny101__gentle-ocean-waves-loop.wav
src/
  components/
    TownscaperTown/        OBJ読み込み + 専用シェーダ + ステンシル窓 + 水面 + コライダー
    SkyDome/               トゥーン調スカイボックス
    AmbientAudio/          環境音ループ
  World.tsx                配置・ライティング・スポーン
  dev.tsx / index.tsx      開発用エントリ / 本番エクスポート
xrift.json                 XRift ワールド設定
```

## クレジット

- **Townscaper** — [Oskar Stålberg](https://oskarstalberg.com/Townscaper/)（3D モデル / テクスチャの著作権は原作者に帰属）
- **レンダリング手法・magic texture** — [Reinder Nijhoff](https://reindernijhoff.net/2021/11/townscapers-rendering-style-in-webgl/)
- **環境音** — `852826__kkenny101__gentle-ocean-waves-loop.wav`（ファイル名由来: kkenny101。再利用時は元音源のライセンスを確認してください）
- **XRift 移植・シェーダ実装** — このリポジトリ

## ライセンス

MIT（`LICENSE` を参照）。同梱の Townscaper 由来アセットと環境音ファイルは上記クレジットの権利者に帰属し、MIT ライセンスの対象外です。
