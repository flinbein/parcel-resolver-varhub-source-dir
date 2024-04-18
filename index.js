const fs = require("node:fs");
const path = require("node:path");
const typescript = require("typescript");
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
		return JSON.stringify(JSON.parse(data.toString("utf-8")));
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
		return outputText;
	}
	return data.toString("utf-8");
}

function fixFileName(path){
	return path.replace(/\.t(sx?)$/, ".j$1").replace(/\.mts$/, ".mjs");
}

module.exports = new Resolver({
	async resolve({dependency, specifier, pipeline}) {
		if (pipeline !== "varhub-modules" && pipeline !== "varhub-modules-integrity") return;
		const [spec, ...opts] = specifier.split(":");
		const index = opts.length > 0 ? opts.join(":") : null;
		// todo: help text
		const sourceFilePath = dependency.resolveFrom ?? dependency.sourcePath;

		const modulesRootDir = path.join(sourceFilePath, "..", spec, "/");
		const fileLocations = await getFileLocations(modulesRootDir, "");
		if (fileLocations.length === 0) {
			throw new Error(`wrong specifier "varhub-modules:${specifier}": directory is empty"`);
		}
		if (index === null) {
			const fixedName = fuzzyFind("index.ts", fileLocations.map(fl => fl.moduleName));
			throw new Error(`main file is not defined in specifier "${pipeline}:${specifier}". Did you mean "${pipeline}:${spec}:${fixedName}"?`);
		}

		const main = fixFileName(index);
		if (!fileLocations.some((fl) => fixFileName(fl.moduleName) === main)) {
			const fixedName = fuzzyFind(index, fileLocations.map(fl => fl.moduleName));
			throw new Error(`wrong main file "${index}" in specifier "${pipeline}:${specifier}". Did you mean "${pipeline}:${spec}:${fixedName}"?`);
		}

		const source = {};
		const module = { main, source };
		await Promise.all(fileLocations.map(async (fl) => source[fixFileName(fl.moduleName)] = await fileToJson(fl, index)));
		const integrity = getStableHash(module, "sha256", "hex");

		if (pipeline === "varhub-modules") {
			return {
				filePath: path.join(modulesRootDir, `.varhub-modules.${btoa(index ?? "")}.js`),
				code: `export const roomIntegrity=${JSON.stringify(integrity)};export const roomModule=${objToSourceCode(module)};`,
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
	if (obj instanceof Uint8Array) {
		return "Uint8Array.from([" + [...obj] + "])";
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

function fuzzyFind(str, options){
	let result = undefined, level = Infinity;
	for (let option of options) {
		const dist = levenshteinDistance(str, option);
		if (dist < level) {
			result = option;
			level = dist;
		}
	}
	return result;
}

function levenshteinDistance(str1, str2) {
	const len1 = str1.length;
	const len2 = str2.length;

	let matrix = Array(len1 + 1);
	for (let i = 0; i <= len1; i++) matrix[i] = Array(len2 + 1);

	for (let i = 0; i <= len1; i++) matrix[i][0] = i;

	for (let j = 0; j <= len2; j++) matrix[0][j] = j;

	for (let i = 1; i <= len1; i++) {
		for (let j = 1; j <= len2; j++) {
			if (str1[i - 1] === str2[j - 1]) {
				matrix[i][j] = matrix[i - 1][j - 1];
			} else {
				matrix[i][j] = Math.min(
					matrix[i - 1][j] + 1,
					matrix[i][j - 1] + 1,
					matrix[i - 1][j - 1] + 1
				);
			}
		}
	}

	return matrix[len1][len2];
}
