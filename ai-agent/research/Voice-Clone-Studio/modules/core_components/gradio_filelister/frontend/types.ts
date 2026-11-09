import type { LoadingStatus } from "@gradio/statustracker";

export interface FileItem {
	name: string;
	date: string;
	type?: "audio" | "video" | "text" | "folder" | "file";
}

export interface FileListerValue {
	files: FileItem[];
	selected: string[];
}

export interface FileListerProps {
	value: FileListerValue;
	file_count: "single" | "multiple";
	height: number;
	show_footer: boolean;
	show_icons: boolean;
	show_date: boolean;
	show_type_column: boolean;
	selected_color: string | null;
	font_size: string | null;
	row_padding: number;
	date_width: number;
	type_width: number;
	striped: boolean;
	name_label: string;
	date_label: string;
	type_label: string;
}

export interface FileListerEvents {
	change: never;
	input: never;
	select: { index: number; value: FileItem; selected: boolean };
	double_click: { index: number; value: FileItem };
	clear_status: LoadingStatus;
}
