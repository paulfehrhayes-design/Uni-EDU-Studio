<svelte:options accessors={true} />

<script lang="ts">
	import type { FileListerProps, FileListerEvents, FileItem } from "./types";
	import { Gradio } from "@gradio/utils";
	import { BlockTitle } from "@gradio/atoms";
	import { Block } from "@gradio/atoms";
	import { StatusTracker } from "@gradio/statustracker";
	import { onMount, onDestroy } from "svelte";

	const props = $props();
	const gradio = new Gradio<FileListerEvents, FileListerProps>(props);

	const container = true;

	// Sort state
	let sort_by = $state<"name" | "date" | "type">("name");
	let sort_asc = $state(true);

	// Derive files and selected from value
	let files = $derived(gradio.props.value?.files ?? []);
	let selected = $derived(new Set(gradio.props.value?.selected ?? []));

	// Auto-detect whether to show date column:
	// show_date prop can override, but if true (default), auto-hide when all dates are empty
	let date_visible = $derived.by(() => {
		const prop = gradio.props.show_date;
		if (prop === false) return false;
		// Auto-detect: hide if every file has an empty date
		const f = files;
		if (f.length === 0) return true;
		return f.some((file: FileItem) => file.date && file.date.trim() !== "");
	});

	// Sorted files — folders always on top (like Windows Explorer)
	let sorted_files = $derived.by(() => {
		const arr = [...files];

		// Partition into folders and non-folders
		const folders: FileItem[] = [];
		const non_folders: FileItem[] = [];
		for (const f of arr) {
			if (get_file_type(f) === "folder") {
				folders.push(f);
			} else {
				non_folders.push(f);
			}
		}

		// Sort function for a group
		function sort_group(group: FileItem[]): FileItem[] {
			return group.sort((a: FileItem, b: FileItem) => {
				let cmp = 0;
				if (sort_by === "name") {
					cmp = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
				} else if (sort_by === "date") {
					cmp = a.date.localeCompare(b.date);
				} else if (sort_by === "type") {
					cmp = get_file_type(a).localeCompare(get_file_type(b));
					if (cmp === 0) cmp = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
				}
				return sort_asc ? cmp : -cmp;
			});
		}

		return [...sort_group(folders), ...sort_group(non_folders)];
	});

	// Last clicked index for shift-select
	let last_clicked_index = $state<number | null>(null);

	// Drag-select state
	let is_dragging = $state(false);
	let drag_start_index = $state<number | null>(null);
	let drag_did_move = $state(false);
	// Flag to block header sort immediately after a drag ends
	let recently_dragged = $state(false);

	// Global mouseup listener — catches releases outside the component
	function global_mouseup() {
		if (is_dragging) {
			if (drag_did_move) {
				recently_dragged = true;
				setTimeout(() => { recently_dragged = false; }, 50);
			}
			is_dragging = false;
			drag_start_index = null;
			drag_did_move = false;
		}
	}

	onMount(() => {
		window.addEventListener("mouseup", global_mouseup);
	});

	onDestroy(() => {
		window.removeEventListener("mouseup", global_mouseup);
	});

	function toggle_sort(column: "name" | "date" | "type") {
		// Block sort if we just finished a drag
		if (recently_dragged) return;
		if (sort_by === column) {
			sort_asc = !sort_asc;
		} else {
			sort_by = column;
			sort_asc = true;
		}
	}

	function update_selection(new_selected: Set<string>, index: number, file: FileItem) {
		last_clicked_index = index;
		gradio.props.value = {
			files: files,
			selected: Array.from(new_selected),
		};
		gradio.dispatch("input");
		gradio.dispatch("change");
		gradio.dispatch("select", {
			index,
			value: file,
			selected: new_selected.has(file.name),
		});
	}

	function handle_mousedown(file: FileItem, index: number, event: MouseEvent) {
		if (!gradio.shared.interactive) return;
		if (event.button !== 0) return; // left click only

		is_dragging = true;
		drag_start_index = index;
		drag_did_move = false;

		const file_count = gradio.props.file_count ?? "multiple";

		if (file_count === "single") {
			const new_selected = selected.has(file.name) ? new Set<string>() : new Set([file.name]);
			update_selection(new_selected, index, file);
		} else if (event.shiftKey && last_clicked_index !== null) {
			// Range select
			const new_selected = new Set(selected);
			const start = Math.min(last_clicked_index, index);
			const end = Math.max(last_clicked_index, index);
			for (let i = start; i <= end; i++) {
				new_selected.add(sorted_files[i].name);
			}
			update_selection(new_selected, index, file);
		} else if (event.ctrlKey || event.metaKey) {
			const new_selected = new Set(selected);
			if (new_selected.has(file.name)) {
				new_selected.delete(file.name);
			} else {
				new_selected.add(file.name);
			}
			update_selection(new_selected, index, file);
		} else {
			// Plain click - select just this one (drag may extend later)
			const new_selected = new Set([file.name]);
			// Skip if selection is already exactly this one file (avoids duplicate change on dblclick)
			if (selected.size === 1 && selected.has(file.name)) {
				last_clicked_index = index;
				is_dragging = true;
				drag_start_index = index;
				return;
			}
			update_selection(new_selected, index, file);
		}

		event.preventDefault();
	}

	function handle_mousemove_during_drag(file: FileItem, index: number) {
		if (!is_dragging || drag_start_index === null) return;
		if (!gradio.shared.interactive) return;

		const file_count = gradio.props.file_count ?? "multiple";
		if (file_count === "single") return;

		drag_did_move = true;

		// Select range from drag start to current
		const new_selected = new Set<string>();
		const start = Math.min(drag_start_index, index);
		const end = Math.max(drag_start_index, index);
		for (let i = start; i <= end; i++) {
			new_selected.add(sorted_files[i].name);
		}

		gradio.props.value = {
			files: files,
			selected: Array.from(new_selected),
		};
		gradio.dispatch("input");
		gradio.dispatch("change");
	}

	function handle_dblclick(file: FileItem, index: number) {
		if (!gradio.shared.interactive) return;
		gradio.dispatch("double_click", { index, value: file });
	}

	// Auto-detect file type from extension
	const AUDIO_EXTS = new Set([".wav", ".mp3", ".flac", ".ogg", ".aac", ".m4a", ".wma", ".opus", ".aiff", ".aif"]);
	const VIDEO_EXTS = new Set([".mp4", ".mkv", ".avi", ".mov", ".wmv", ".webm", ".flv", ".m4v", ".ts"]);
	const TEXT_EXTS = new Set([".txt", ".json", ".yaml", ".yml", ".xml", ".csv", ".md", ".log", ".ini", ".cfg", ".toml", ".conf", ".py", ".js", ".ts", ".html", ".css", ".jsonl"]);

	function get_file_type(file: FileItem): string {
		if (file.type) return file.type;
		const name = file.name.toLowerCase();
		const dot = name.lastIndexOf(".");
		if (dot === -1) return "folder"; // no extension = likely a folder
		const ext = name.substring(dot);
		if (AUDIO_EXTS.has(ext)) return "audio";
		if (VIDEO_EXTS.has(ext)) return "video";
		if (TEXT_EXTS.has(ext)) return "text";
		return "file";
	}

	function sort_indicator(column: "name" | "date" | "type"): string {
		if (sort_by !== column) return "";
		return sort_asc ? " \u25B2" : " \u25BC";
	}
</script>

<Block
	visible={gradio.shared.visible}
	elem_id={gradio.shared.elem_id}
	elem_classes={gradio.shared.elem_classes}
	scale={gradio.shared.scale}
	min_width={gradio.shared.min_width}
	allow_overflow={false}
	padding={false}
>
	{#if gradio.shared.loading_status}
		<StatusTracker
			autoscroll={gradio.shared.autoscroll}
			i18n={gradio.i18n}
			{...gradio.shared.loading_status}
			on_clear_status={() =>
				gradio.dispatch("clear_status", gradio.shared.loading_status)}
		/>
	{/if}

	<div class:container>
		{#if gradio.shared.label && gradio.shared.show_label !== false}
			<BlockTitle show_label={gradio.shared.show_label} info={undefined}
				>{gradio.shared.label}</BlockTitle
			>
		{/if}

		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="file-lister"
			style="--list-height: {gradio.props.height ?? 400}px; --date-col-width: {gradio.props.date_width ?? 180}px; --type-col-width: {gradio.props.type_width ?? 90}px; --row-v-padding: {gradio.props.row_padding ?? 6}px; {gradio.props.selected_color ? `--sel-color: ${gradio.props.selected_color};` : ''} {gradio.props.font_size ? `--row-font-size: ${gradio.props.font_size};` : ''}"
		>
			<!-- Header row -->
			<div class="header-row">
				<button
					class="header-cell name-header"
					class:active={sort_by === "name"}
					onclick={() => toggle_sort("name")}
				>
					{gradio.props.name_label ?? "Name"}{sort_indicator("name")}
				</button>
				{#if gradio.props.show_type_column}
					<button
						class="header-cell type-header"
						class:active={sort_by === "type"}
						onclick={() => toggle_sort("type")}
					>
						{gradio.props.type_label ?? "Type"}{sort_indicator("type")}
					</button>
				{/if}
				{#if date_visible}
				<button
					class="header-cell date-header"
					class:active={sort_by === "date"}
					onclick={() => toggle_sort("date")}
				>
					{gradio.props.date_label ?? "Date"}{sort_indicator("date")}
				</button>
				{/if}
			</div>

			<!-- File rows -->
			<div class="file-list">
				{#if sorted_files.length === 0}
					<div class="empty-state">No files</div>
				{:else}
					{#each sorted_files as file, i (file.name)}
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div
							class="file-row"
							class:selected={selected.has(file.name)}
							class:striped={(gradio.props.striped ?? false) && i % 2 === 1}
							role="option"
							aria-selected={selected.has(file.name)}
							tabindex="0"
							onmousedown={(e) => handle_mousedown(file, i, e)}
							onmousemove={() => handle_mousemove_during_drag(file, i)}
							ondblclick={() => handle_dblclick(file, i)}
						>
							{#if gradio.props.show_icons !== false}
								{@const ftype = get_file_type(file)}
								<span class="file-icon" class:folder-icon={ftype === "folder"}>
									{#if ftype === "audio"}
										<!-- Audio: speaker/waveform icon -->
										<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
											<path d="M9 18V5l12-2v13"/>
											<circle cx="6" cy="18" r="3"/>
											<circle cx="18" cy="16" r="3"/>
										</svg>
									{:else if ftype === "video"}
										<!-- Video: clapperboard/film icon -->
										<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
											<rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/>
											<line x1="7" y1="2" x2="7" y2="22"/>
											<line x1="17" y1="2" x2="17" y2="22"/>
											<line x1="2" y1="12" x2="22" y2="12"/>
											<line x1="2" y1="7" x2="7" y2="7"/>
											<line x1="2" y1="17" x2="7" y2="17"/>
											<line x1="17" y1="7" x2="22" y2="7"/>
											<line x1="17" y1="17" x2="22" y2="17"/>
										</svg>
									{:else if ftype === "text"}
										<!-- Text: document with lines icon -->
										<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
											<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
											<polyline points="14 2 14 8 20 8"/>
											<line x1="16" y1="13" x2="8" y2="13"/>
											<line x1="16" y1="17" x2="8" y2="17"/>
											<line x1="10" y1="9" x2="8" y2="9"/>
										</svg>
									{:else if ftype === "folder"}
										<!-- Folder icon -->
										<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
											<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
										</svg>
									{:else}
										<!-- Generic file icon -->
										<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
											<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
											<polyline points="14 2 14 8 20 8"/>
										</svg>
									{/if}
								</span>
							{/if}
							<span class="file-name">{file.name}</span>
							{#if gradio.props.show_type_column}
								<span class="file-type">{get_file_type(file)}</span>
							{/if}
							{#if date_visible}
							<span class="file-date">{file.date}</span>
							{/if}
						</div>
					{/each}
				{/if}
			</div>

			<!-- Footer with selection count -->
			{#if gradio.props.show_footer !== false}
				<div class="footer">
					{selected.size} file{selected.size !== 1 ? "s" : ""} selected
				</div>
			{/if}
		</div>
	</div>
</Block>

<style>
	.container {
		display: block;
		width: 100%;
	}

	.file-lister {
		background: var(--input-background-fill);
		overflow: hidden;
		display: flex;
		flex-direction: column;
	}

	.header-row {
		display: flex;
		border-bottom: 2px solid var(--border-color-primary);
		background: var(--block-background-fill);
		flex-shrink: 0;
		user-select: none;
	}

	.header-cell {
		padding: 8px 12px;
		font-weight: 600;
		font-size: var(--text-sm);
		color: var(--body-text-color);
		cursor: pointer;
		border: none;
		background: transparent;
		text-align: left;
		transition: background 0.15s ease;
		display: flex;
		align-items: center;
		gap: 4px;
		white-space: nowrap;
	}

	.header-cell:hover {
		background: var(--background-fill-primary);
	}

	.header-cell:focus {
		outline: none;
	}

	.header-cell.active {
		color: var(--color-accent);
	}

	.name-header {
		flex: 1;
		min-width: 0;
	}

	.date-header {
		width: var(--date-col-width, 180px);
		flex-shrink: 0;
	}

	.type-header {
		width: var(--type-col-width, 90px);
		flex-shrink: 0;
	}

	.file-list {
		overflow-y: auto;
		max-height: var(--list-height);
		scrollbar-width: thin;
	}

	.file-list::-webkit-scrollbar {
		width: 6px;
	}

	.file-list::-webkit-scrollbar-track {
		background: transparent;
	}

	.file-list::-webkit-scrollbar-thumb {
		background: var(--border-color-primary);
		border-radius: 3px;
	}

	.empty-state {
		padding: 32px;
		text-align: center;
		color: var(--body-text-color-subdued);
		font-size: var(--text-sm);
	}

	.file-row {
		display: flex;
		align-items: center;
		padding: var(--row-v-padding, 6px) 12px;
		border: none;
		border-left: 3px solid transparent;
		border-bottom: 1px solid var(--border-color-primary);
		background: transparent;
		cursor: pointer;
		width: 100%;
		text-align: left;
		transition: background 0.1s ease, border-color 0.1s ease;
		color: var(--body-text-color);
		font-size: var(--row-font-size, var(--text-sm));
		gap: 0;
		user-select: none;
	}

	.file-row:last-child {
		border-bottom: none;
	}

	.file-row:hover {
		background: var(--background-fill-secondary);
	}

	.file-row.striped {
		background: var(--background-fill-secondary);
	}

	.file-row.selected {
		background: color-mix(in srgb, var(--sel-color, var(--color-accent, #3b82f6)) 15%, transparent);
		border-left: 3px solid var(--sel-color, var(--color-accent, #3b82f6));
		padding-left: 9px;
	}

	.file-row.selected:hover {
		background: color-mix(in srgb, var(--sel-color, var(--color-accent, #3b82f6)) 15%, transparent);
		filter: brightness(0.93);
	}

	.file-row.selected .file-name {
		color: var(--sel-color, var(--color-accent, #3b82f6));
		font-weight: 600;
	}

	.file-row.selected .file-date {
		color: var(--sel-color, var(--color-accent, #3b82f6));
		opacity: 0.8;
	}

	.file-icon {
		display: flex;
		align-items: center;
		margin-right: 8px;
		color: var(--body-text-color-subdued);
		flex-shrink: 0;
	}

	.file-icon.folder-icon {
		color: var(--color-accent, #3b82f6);
		opacity: 0.75;
	}

	.file-row.selected .file-icon {
		color: var(--sel-color, var(--color-accent, #3b82f6));
	}

	.file-name {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
		transition: color 0.1s ease;
	}

	.file-date {
		width: calc(var(--date-col-width, 180px) - 12px);
		flex-shrink: 0;
		color: var(--body-text-color-subdued);
		text-align: right;
		transition: color 0.1s ease;
	}

	.file-type {
		width: calc(var(--type-col-width, 90px) - 12px);
		flex-shrink: 0;
		color: var(--body-text-color-subdued);
		text-transform: capitalize;
		font-size: var(--text-xs);
		transition: color 0.1s ease;
	}

	.file-row.selected .file-type {
		color: var(--sel-color, var(--color-accent, #3b82f6));
		opacity: 0.8;
	}

	.footer {
		padding: 6px 12px;
		border-top: 1px solid var(--border-color-primary);
		background: var(--background-fill-secondary);
		font-size: var(--text-xs);
		color: var(--body-text-color-subdued);
		flex-shrink: 0;
	}
</style>
