npm run tauri dev

npm run tauri build

cd injector32
cargo build --release --target i686-pc-windows-msvc


用途	前端	Rust
看可升级（semver 内）	npm outdated	cargo update --dry-run
应用升级	npm update	cargo update
跨大版本	npx npm-check-updates -u	cargo install cargo-outdated → cargo outdated（cargo-edit 的 cargo upgrade 可改 Cargo.toml 约束）
安全漏洞	npm audit	cargo install cargo-audit → cargo audit