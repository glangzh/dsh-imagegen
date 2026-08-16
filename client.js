window.__ModuleLoader__.load({
	id: "dsh-imagegen",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");

		/** Services: the settings-plugins tab slot, the connection (api face) and the settings scope. */
		const inject = ["slots", "connection", "settingsScope"];
		const NS = "imagegen";
		const FALLBACK_KEY_REF = "IMAGE_API_KEY";
		/** Non-secret, namespace-backed fields — real values are displayed. */
		const TEXT_FIELDS = [
			{ key: "baseUrl", label: "Base URL", placeholder: "默认 https://api.agnes-ai.cn（可带 /v1）" },
			{ key: "imageModel", label: "生图模型" },
			{ key: "visionModel", label: "视觉模型" }
		];

		const formStyle = { display: "flex", flexDirection: "column", gap: "12px", maxWidth: "560px", padding: "2px 0" };
		const fieldStyle = { display: "flex", flexDirection: "column", gap: "4px" };
		const lblStyle = { fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-secondary)" };
		const inpStyle = {
			boxSizing: "border-box", width: "100%", height: "34px", padding: "0 10px",
			border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-1)",
			color: "var(--dsw-alias-label-primary)", borderRadius: "8px", font: "inherit", fontSize: "13px"
		};
		const btnStyle = {
			border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-1)",
			color: "var(--dsw-alias-label-primary)", borderRadius: "6px", cursor: "pointer",
			font: "inherit", fontSize: "13px", padding: "6px 16px"
		};
		const btnPrimary = { ...btnStyle, background: "var(--dsw-alias-state-business-primary)", color: "#fff", border: "none" };
		const btnPrimaryDisabled = { ...btnPrimary, opacity: 0.45, cursor: "default" };
		const okStyle = { color: "var(--dsw-alias-state-success-primary)", fontSize: "12px" };
		const mutedStyle = { color: "var(--dsw-alias-label-tertiary)", fontSize: "12px" };
		const errStyle = { color: "var(--dsw-alias-state-error-primary)", fontSize: "12px" };
		const actionsStyle = { display: "flex", alignItems: "center", gap: "10px", marginTop: "2px" };

		function ImagegenSettingsTab(props) {
			const scope = props.scope;
			const api = props.api;
			const snapshot = React.useSyncExternalStore(
				(cb) => scope.subscribe(cb),
				() => scope.getSnapshot()
			);
			const value = snapshot.value || {};

			// Local drafts + which fields the user actually edited.
			const [drafts, setDrafts] = React.useState({});
			const [edited, setEdited] = React.useState(() => new Set());
			const [keyText, setKeyText] = React.useState("");
			const [cred, setCred] = React.useState(undefined); // {configured, source, writable}
			const [busy, setBusy] = React.useState(false);
			const [error, setError] = React.useState("");

			const keyRef = value.apiKeyEnv || FALLBACK_KEY_REF;
			const configured = Boolean(cred && cred.configured);

			// Sync namespace values into drafts for fields the user has not edited.
			React.useEffect(() => {
				setDrafts((prev) => {
					const next = { ...prev };
					for (const f of TEXT_FIELDS) if (!edited.has(f.key)) next[f.key] = value[f.key] ?? "";
					return next;
				});
			}, [value, edited]);

			// Load the key credential state (value never leaves the host).
			React.useEffect(() => {
				let alive = true;
				api.credentials.describe({ refs: [keyRef] }).then((res) => {
					if (!alive) return;
					const c = (res && res.result && res.result.ok && res.result.value && res.result.value.credentials && res.result.value.credentials[keyRef]) || { configured: false, source: undefined, writable: true };
					setCred(c);
				}).catch(() => alive && setCred({ configured: false, source: undefined, writable: true }));
				return () => { alive = false; };
			}, [api, keyRef]);

			const writable = cred ? cred.writable !== false : true;
			const hasEdits = edited.size > 0 || Boolean(keyText.trim());
			const canSave = hasEdits && writable && !busy;

			const save = async () => {
				setBusy(true);
				setError("");
				try {
					for (const f of TEXT_FIELDS) {
						if (edited.has(f.key) && drafts[f.key] !== (value[f.key] ?? "")) {
							await scope.set(f.key, drafts[f.key] ?? "");
						}
					}
					if (keyText.trim()) await api.credentials.set({ ref: keyRef, value: keyText.trim() });
					setKeyText("");
					setEdited(new Set());
				} catch (e) {
					setError("保存失败。");
				}
				setBusy(false);
			};

			const clearAll = async () => {
				setBusy(true);
				setError("");
				try {
					await api.credentials.unset({ ref: keyRef });
					for (const f of TEXT_FIELDS) await scope.unset(f.key);
					await scope.unset("autoTranslate");
					setKeyText("");
					setEdited(new Set());
				} catch (e) {
					setError("清除失败。");
				}
				setBusy(false);
			};

			if (snapshot.status === "loading") return React.createElement("div", { style: mutedStyle }, "加载配置中…");
			if (snapshot.status === "unavailable") {
				return React.createElement("div", { style: errStyle }, "配置命名空间不可用。请重启应用后重试。");
			}

			const fields = [];
			fields.push(React.createElement("div", { key: "key", style: fieldStyle }, [
				React.createElement("label", { style: lblStyle }, "API Key"),
				React.createElement("input", {
					type: "password", value: keyText,
					placeholder: value.apiKeyMask ? value.apiKeyMask : (configured ? "************" : "输入 API key（sk-…）"),
					style: inpStyle, spellCheck: false, autoComplete: "off",
					disabled: busy || !writable,
					onChange: (e) => setKeyText(e.target.value)
				})
			]));
			for (const f of TEXT_FIELDS) {
				fields.push(React.createElement("div", { key: f.key, style: fieldStyle }, [
					React.createElement("label", { style: lblStyle }, f.label),
					React.createElement("input", {
						type: "text", value: drafts[f.key] ?? "",
						placeholder: f.placeholder, style: inpStyle, spellCheck: false,
						disabled: busy || !writable,
						onChange: (e) => {
							setEdited((prev) => new Set(prev).add(f.key));
							setDrafts((prev) => ({ ...prev, [f.key]: e.target.value }));
						}
					})
				]));
			}

			fields.push(React.createElement("div", { key: "actions", style: actionsStyle }, [
				React.createElement("button", {
					style: canSave ? btnPrimary : btnPrimaryDisabled,
					disabled: !canSave,
					onClick: save
				}, busy ? "保存中…" : (configured ? "更新" : "保存")),
				configured && !busy
					? React.createElement("button", { style: btnStyle, onClick: clearAll }, "清除配置")
					: null
			]));
			if (error) fields.push(React.createElement("div", { key: "error", style: errStyle }, error));

			return React.createElement("div", { style: formStyle }, fields);
		}

		function apply(ctx) {
			const api = ctx.connection.api;
			const scope = ctx.settingsScope.bind({ namespace: NS });
			ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register({
				name: "settings.plugins.tab",
				id: "dsh-imagegen",
				order: 20,
				label: () => "图像生成",
				inject: () => ({ api, scope })
			}, ImagegenSettingsTab));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
