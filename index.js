const fs = require("node:fs");
const path = require("node:path");
const mimeTypes = require("mime-types");
const {Resolver} = require("@parcel/plugin");

async function getFileLocations(dir, urlPath){
	return new Promise((resolve, reject) => {
		fs.readdir(dir, async (error, files) => {
			if (error) return reject(error);
			const fileLocations = await Promise.all(
				files.flatMap(async (file) => {
					const stat = await getStat(path.join(dir, file));
					if (stat.isFile()) return urlPath+file;
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

module.exports = new Resolver({
	async resolve({dependency, options, logger, specifier, pipeline, config}) {
		if (pipeline !== "varhub-modules") return;
		const [spec, index = null] = specifier.split(":")
		const sourceFilePath = dependency.resolveFrom ?? dependency.sourcePath;

		const modulesRootDir = path.join(sourceFilePath, "..", spec, "/");
		const fileLocations = await getFileLocations(modulesRootDir, "/");
		const moduleItems = fileLocations.map(fileLoc => {
			const requireCode = `require(${JSON.stringify("varhub-source:"+spec+fileLoc)})`
			const obj = {};
			if (fileLoc.endsWith(".json")){
				obj["type"] = JSON.stringify("json");
				obj["source"] = requireCode;
			} else if (fileLoc.endsWith(".js")||fileLoc.endsWith(".ts")){
				obj["type"] = JSON.stringify("js");
				obj["source"] = requireCode;
				if (fileLoc === index) {
					obj["evaluate"] = "true";
					obj["hooks"] = JSON.stringify("*");
				}
			} else if (mimeTypes.lookup(fileLoc)?.startsWith("text/")){
				obj["type"] = JSON.stringify("text");
				obj["source"] = requireCode;
			} else {
				obj["type"] = JSON.stringify("bin");
				obj["source"] = requireCode;
			}
			const code = `{${Object.entries(obj).map(([k,v]) => {
				return `${k}:${v}`
			}).join(",")}}`
			return {module: fileLoc, code}
		});
		const objectLines = moduleItems.map(({module, code}) => {
			return `[${JSON.stringify(module)}]:${code}`
		})
		const code = `
			module.exports={${objectLines.join(",")}}
		`
		return {
			filePath: sourceFilePath + `.${btoa(specifier)}.js`,
			code: code,
			pipeline: null,
		};
	}
});
