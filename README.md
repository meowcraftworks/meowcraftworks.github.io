# meow.craft.works 公式サイト

屋号「meow.craft.works」の iOS アプリ開発事業 公式サイト。
Apple Developer Program の**組織（Organization）審査**通過を主目的とした静的サイト（素の HTML/CSS）。

## 構成
```
/
├── index.html      トップ（事業紹介 + アプリ一覧 + 事業者情報）
├── privacy.html    プライバシーポリシー
├── support.html    サポート / お問い合わせ
├── terms.html      利用規約
├── style.css       共通スタイル
├── CNAME           独自ドメイン（meowcraftworks.com）
└── assets/         アプリアイコン画像（要差し替え）
```

## 公開手順（GitHub Pages）
1. GitHub アカウント `meowcraftworks` で公開用リポジトリを作成
2. このフォルダの中身をルートに push
3. Settings → Pages → Branch: `main` / `/ (root)` を選択して保存
4. カスタムドメインに `meowcraftworks.com` を設定（CNAME ファイルで自動設定される）
5. **Enforce HTTPS** をオン
6. XServer 側 DNS で GitHub Pages 向けレコードを設定：
   - A レコード（`@`）→ `185.199.108.153` / `185.199.109.153` / `185.199.110.153` / `185.199.111.153`
   - CNAME（`www`）→ `meowcraftworks.github.io`
   （※ 上記 IP は GitHub Pages の公式値。最新は GitHub Docs を確認）
7. 公開 URL を Apple Developer の組織申請フォームに記入

## 差し替えが必要なプレースホルダ（`TODO(差し替え)` コメント箇所）
- `[App Store URL]` … 各アプリの App Store URL（index.html）
- アプリアイコン … `assets/app-kakeibo.png` / `assets/app-kintore.png`
- 連絡先メール … 現在 `contact@meowcraftworks.com`（独自ドメインメール設定後に確定）
- 代表者名・所在地 … 公開可否に応じて index.html の該当 `<tr>` を編集/削除

## アプリを増やすとき
index.html の `<!-- ▼▼ アプリカード ... ▼▼ -->` 内の `<article class="app-card">` を
丸ごとコピーして 1 ブロック追加すれば増やせます。
