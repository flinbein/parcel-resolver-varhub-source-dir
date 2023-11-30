const fs = require("node:fs");
const path = require("node:path");
const typescript = require("typescript");
const mimeTypes = require("mime-types");
const {Resolver} = require("@parcel/plugin");
const {normalizeSeparators} = require("@parcel/utils");
const getStableHash = require("@flinbein/json-stable-hash");

async function getFileLocations(dir, urlPath){
	return new Promise((resolve, reject) => {
		fs.readdir(dir, async (error, files) => {
			if (error) return reject(error);
			const fileLocations = await Promise.all(
				files.flatMap(async (file) => {
					const filePath = path.join(dir, file);
					const stat = await getStat(filePath);
					if (stat.isFile()) return {path: filePath, moduleName: urlPath+file};
					if (stat.isDirectory()) return await getFileLocations(path.join(dir, file), urlPath+file+"/");
					return [];
				})
			);
			resolve(fileLocations.flat(1));
		})
	});
}
async function getStat(filePath){
	return new Promise((resolve, reject) => {
		fs.lstat(filePath, (err, stat) => err ? reject(err) : resolve(stat));
	})
}

async function readFile(path) {
	return new Promise((resolve, reject) => {
		fs.readFile(path, (err, stat) => err ? reject(err) : resolve(stat));
	});
}

async function fileToJson({path, moduleName}, main) {
	const data = await readFile(path);
	if (path.endsWith(".json")) {
		return {type: "json", source: JSON.stringify(JSON.parse(data.toString("utf-8")))}
	}
	if (path.endsWith(".js")) {
		const result = {type: "js", source: data.toString("utf-8")}
		if (moduleName === "main") {
			result.evaluate = true;
			result.hooks = "*"
		}
		return result;
	}
	if (path.endsWith(".ts") || path.endsWith(".mts")) {

		const {outputText} = typescript.transpileModule(
			data.toString("utf-8"),
			{
				compilerOptions: {
					jsx: typescript.JsxEmit.React,
					noEmit: false,
					module: typescript.ModuleKind.ESNext,
					sourceMap: false,
					mapRoot: "/",
					removeComments: true
				},
				fileName: path,
			},
		);
		const result = {type: "js", source: outputText}
		if (moduleName === main) {
			result.evaluate = true;
			result.hooks = "*";
		}
		return result;
	}
	if (mimeTypes.lookup(path)?.startsWith("text/")){
		return {type: "text", source: data.toString("utf-8")}
	}
	return {type: "bin", source: new Uint8Array(data.buffer, data.byteOffset, data.byteLength)};
}

module.exports = new Resolver({
	async resolve({dependency, specifier, pipeline}) {
		if (pipeline !== "varhub-modules" && pipeline !== "varhub-modules-integrity") return;
		const [spec, index = null] = specifier.split(":");
		const sourceFilePath = dependency.resolveFrom ?? dependency.sourcePath;

		const modulesRootDir = path.join(sourceFilePath, "..", spec, "/");
		const fileLocations = await getFileLocations(modulesRootDir, "/");
		const modules = {};
		await Promise.all(fileLocations.map(async (fl) => modules[fl.moduleName] = await fileToJson(fl, index)));
		const integrity = getStableHash(modules, "sha256", "hex");

		if (pipeline === "varhub-modules") {
			return {
				filePath: path.join(modulesRootDir, `.varhub-modules.${btoa(index ?? "")}.js`),
				code: `export const integrity=${JSON.stringify(integrity)};export const modules=${objToSourceCode(modules)};`,
				invalidateOnFileCreate: [{glob: normalizeSeparators(modulesRootDir)+"**/*"}],
				invalidateOnFileChange: fileLocations.map(d=>d.path),
				pipeline: null,
			};
		}
		if (pipeline === "varhub-modules-integrity") {
			return {
				filePath: path.join(modulesRootDir, `.varhub-modules-integrity.${btoa(index ?? "")}.json`),
				code: JSON.stringify(integrity),
				invalidateOnFileCreate: [{glob: normalizeSeparators(modulesRootDir)+"**/*"}],
				invalidateOnFileChange: fileLocations.map(d=>d.path),
				pipeline: null,
			};
		}
	}
});

function objToSourceCode(obj){
	if (obj instanceof Buffer) {
		return "Uint8Array.of(" + [...obj] + ")";
	}
	if (Array.isArray(obj)) {
		return "[" + obj.map(objToSourceCode).join(",") + "]";
	}
	if (typeof obj === "object") {
		return `{${Object.entries(obj).map(([key, value]) => (
			(key.match(/^[a-z]*$/) ? key : `[${JSON.stringify(key)}]`) + ":" + objToSourceCode(value)
		)).join(",")}}`
	}
	return JSON.stringify(obj);
}
