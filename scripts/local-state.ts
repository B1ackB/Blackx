import { resolve } from "node:path";
import { configureLocalData, recoverLocalLock, within } from "../server/localData";
import { createBackup, restoreBackup, verifyBackup } from "../server/localBackup";

try {
	const [action, source, destination, ...extra] = process.argv.slice(2);
	const data = configureLocalData(process.env);
	if (extra.length) throw new Error("unexpected_arguments");
	if (action === "recover-lock" && !source && !destination) {
		recoverLocalLock(data.root); console.log("Abandoned Host lock recovered. You can restart Packx.");
	} else if (action === "backup" && source && !destination) {
		if (Object.values(data.paths).some((path) => !within(data.root, path))) throw new Error("custom_paths_outside_data_root: consolidate configuration before backup");
		const standard = configureLocalData({ BLACKX_DATA_ROOT: data.root, BLACKX_STAGE_JOB_QUEUE_DRIVER: process.env.BLACKX_STAGE_JOB_QUEUE_DRIVER });
		if (Object.keys(data.paths).some((key) => data.paths[key] !== standard.paths[key])) throw new Error("custom_store_layout: automatic backup supports the standard layout only; see docs/local-operations.md");
		const result = createBackup(data.root, resolve(source));
		console.log(`Backup verified: ${result.files.length} files. Keep it private; it contains local business data.`);
	} else if (action === "verify" && source && !destination) {
		console.log(`Backup verified: ${verifyBackup(resolve(source)).files.length} files.`);
	} else if (action === "restore" && source && destination) {
		const result = restoreBackup(resolve(source), resolve(destination));
		console.log(`Restored ${result.files.length} files to a new directory. Set BLACKX_DATA_ROOT to that directory; see docs/local-operations.md.`);
	} else throw new Error("Usage: npm run state -- recover-lock | backup NEW_DIRECTORY | verify BACKUP_DIRECTORY | restore BACKUP_DIRECTORY NEW_DATA_DIRECTORY");
} catch (error) { console.error(error instanceof Error ? error.message : "local_state_failed"); process.exitCode = 1; }
