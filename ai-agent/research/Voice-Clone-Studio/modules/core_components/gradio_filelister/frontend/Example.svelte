<script lang="ts">
	export let value: any;
	export let type: "gallery" | "table";
	export let selected = false;

	function display_value(v: any): string {
		if (!v) return "";
		if (typeof v === "object" && v.files) {
			return `${v.files.length} file(s)`;
		}
		if (Array.isArray(v)) {
			return `${v.length} file(s)`;
		}
		return String(v);
	}
</script>

<div
	class:table={type === "table"}
	class:gallery={type === "gallery"}
	class:selected
>
	{display_value(value)}
</div>

<style>
	.gallery {
		padding: var(--size-1) var(--size-2);
	}

	div {
		overflow: hidden;
		white-space: nowrap;
	}
</style>
