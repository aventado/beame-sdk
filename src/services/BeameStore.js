'use strict';
var async       = require('async');
//var exec        = require('child_process').exec;
var fs          = require('fs');
var _           = require('underscore');
var os          = require('os');
var debug       = require("debug")("beamestore");
var config      = require('../../config/Config');
var jmespath    = require('jmespath');
var beameDirApi = require('./BeameDirServices');
var sprintf     = require('sprintf');
var mkdirp      = require('mkdirp');
var path        = require('path');
var request     = require('sync-request');
var apiConfig   = require("../../config/ApiConfig.json");
var url         = require('url');
// The idea is this object framework above BeameDirServices.js
// BeameStore will load the directory and manage it in memory as well be capabale proving high level
// API to work with JSON.
//
// BeameStore.prototype.listCurrentDevelopers
// BeameStore.prototype.listCurrentAtoms
// BeameStore.prototype.listCurrentEdges
// There functions right now return all developers, atoms edges. Then with the search function you can query indivulal levels.
//
//

// beame.store offers api for accessing beame.dir datastructre, upon construction it will parse the directory structure, and produce a json object structure.
//

var beameStoreInstance = null;

function BeameStore() {

	if (beameStoreInstance) {
		return beameStoreInstance;
	}

	mkdirp.sync(config.localCertsDir);
	mkdirp.sync(config.remoteCertsDir);
	this.ensureFreshBeameStore();

	this.listFunctions = [
		{type: "developer", 'func': this.listCurrentDevelopers},
		{type: "atom", 'func': this.listCurrentAtoms},
		{type: "edgeclient", 'func': this.listCurrentEdges}
	];

	this.searchFunctions = [
		{type: "developer", 'func': this.searchDevelopers},
		{type: "atom", 'func': this.searchAtoms},
		{type: "edgeclient", 'func': this.searchEdge}
	];

	beameStoreInstance = this;
}


BeameStore.prototype.jsearch = function (searchItem, level) {
	if (!searchItem) {
		return new Error({"Status": "error", "Message": "searchDevelopers called with either name and fqdn"});
	}

	var queryString = "";

	switch (level) {
		case "developer": {
			queryString = sprintf("[?(hostname=='%s' )|| (name =='%s' )].{name:name, hostname:hostname, level:level} ", searchItem, searchItem);
			break;
		}

		case "atom": {
			queryString = sprintf("[].atom[?(hostname=='%s') || (name=='%s')].{name:name, hostname:hostname, level:level}| []", searchItem, searchItem);
			break;
		}

		case "edgeclient": {
			queryString = sprintf("[].atom[].edgeclient[?(hostname=='%s')].{name:name, hostname:hostname, level:level} | []", searchItem, searchItem);
			break;
		}
		default: {
			throw new Error("Invalid level passed to search ", level);
		}
	}
	debug("Query string " + queryString);
	return jmespath.search(this.beameStore, queryString);

};

BeameStore.prototype.searchDevelopers = function (name) {
	var names      = this.jsearch(name, "developer");
	var returnDict = [];

	_.each(names, _.bind(function (item) {
		var qString = sprintf("[?hostname == '%s'] | []", item.hostname);
		returnDict  = returnDict.concat(jmespath.search(this.beameStore, qString));
	}, this));
	return returnDict;
};

BeameStore.prototype.searchAtoms = function (name) {
	var names      = this.jsearch(name, "atom");
	var returnDict = [];

	_.each(names, _.bind(function (item) {
		var qString = sprintf("[].atom[?hostname == '%s'] | []", item.hostname);
		returnDict  = returnDict.concat(jmespath.search(this.beameStore, qString));
	}, this));
	return returnDict;
};

BeameStore.prototype.searchEdge = function (name) {
	var names      = this.jsearch(name, "edgeclient");
	var returnDict = [];

	_.each(names, _.bind(function (item) {
		var qString = sprintf("[].atom[].edgeclient[?hostname == '%s'] | []", item.hostname);
		returnDict  = returnDict.concat(jmespath.search(this.beameStore, qString));
	}, this));
	return returnDict;
};

/**
 * @typedef {Object} ItemAndParentFolderPath
 * @param {String} path
 * @param {String} parent_path
 */

/**
 *
 * @param {String} fqdn
 * @returns {typeof ItemAndParentFolderPath}
 */

BeameStore.prototype.searchItemAndParentFolderPath = function (fqdn) {
	try {
		var item = this.search(fqdn)[0];
		if (!(item && item.path))
			return {};
		if (item.parent_fqdn != null) {
			var parent = this.search(item.parent_fqdn)[0];
			return {path: item.path, parent_path: parent.path};
		}
		return {path: item.path};
	}
	catch (e) {
		return {};
	}
};

BeameStore.prototype.listCurrentDevelopers = function () {
	return jmespath.search(this.beameStore, "[*].{name:name, hostname:hostname, level:level} | []");
};

BeameStore.prototype.listCurrentAtoms = function () {
	return jmespath.search(this.beameStore, "[*].atom[*].{name:name, hostname:hostname, level:level} | []");
};

BeameStore.prototype.listCurrentEdges = function () {
	return jmespath.search(this.beameStore, "[].atom[].edgeclient[*].{name:name, hostname:hostname, level:level} | []");
};

BeameStore.prototype.ensureFreshBeameStore = function () {
	var newHash = beameDirApi.generateDigest(config.localCertsDir);
	if (this.digest !== newHash) {
		debug("reading beamedir %j", config.localCertsDir);
		this.beameStore = beameDirApi.readBeameDir(config.localCertsDir);
		this.digest     = newHash;
	}
};

BeameStore.prototype.search = function (name) {
	this.ensureFreshBeameStore();

	var results = _.map(this.searchFunctions, _.bind(function (item) {
		return item.func.call(this, name);
	}, this));
	results     = _.flatten(results, true);
	return results;
};

BeameStore.prototype.list = function (type, name) {
	this.ensureFreshBeameStore();

	var returnArray = [];
	if (type && type.length) {
		var listFunc = _.where(this.listFunctions, {'type': type});
		if (listFunc.length != 1) {
			throw new Error("Listfunc dictionary is broken -- bad code change ")
		}
		var newArray = listFunc[0].func.call(this);
		returnArray  = returnArray.concat(newArray);
		return returnArray;
	} else {
		if (name && name.length) {
			var fullResult = [];
			_.each(this.listFunctions, _.bind(function (item) {
				var newArray = item.func.call(this);
				fullResult   = fullResult.concat(newArray);
			}, this));

			return _.filter(fullResult, function (item) {
				if (item.hostname.indexOf(name) != -1) {
					return true;
				}
			});

		}
		_.each(this.listFunctions, _.bind(function (item) {
			returnArray = returnArray.concat(item.func.call(this));
		}, this));
		return returnArray;
	}
};

BeameStore.prototype.getRemoteCertificate = function (fqdn) {
	var remoteCertPath = path.join(config.remoteCertsDir, fqdn, 'x509.pem');
	var certBody       = "";
	if (fs.existsSync(remoteCertPath)) {
		certBody = fs.readFileSync(remoteCertPath);
	} else {
		var requestPath = apiConfig.Endpoints.CertEndpoint + '/' + fqdn + '/' + 'x509.pem';
		console.warn(`Getting certificate from ${requestPath}`);
		var response = request('GET', requestPath);
		//noinspection JSUnresolvedFunction
		certBody     = response.getBody() + "";

		//noinspection JSUnresolvedVariable
		if (response.statusCode == 200) {
			mkdirp(path.parse(remoteCertPath).dir);
			console.warn("Saving file to %j", remoteCertPath);
			fs.writeFileSync(remoteCertPath, certBody);
		}
	}
	return certBody;
};

BeameStore.prototype.importCredentials = function (data) {
	//noinspection ES6ModulesDependencies,NodeModulesDependencies
	var credToImport = JSON.parse(data);
	//var host         = credToImport.hostname;
	var targetPath   = path.join(config.localCertsDir, credToImport.path);
	mkdirp(targetPath);

	var metadata = {};
	_.map(credToImport, function (value, key) {
		if (config.CertFileNames[key]) {
			var filepath = path.join(targetPath, config.CertFileNames[key]);
			fs.writeFileSync(filepath, new Buffer(value.data));

		} else {
			metadata[key] = value;
		}
	});
	//noinspection ES6ModulesDependencies,NodeModulesDependencies
	fs.writeFileSync(path.join(targetPath, "metadata.json"), JSON.stringify(metadata));
	return true;
};

BeameStore.prototype.shredCredentials = function (fqdn, callback) {
	// XXX: Fix callback to get (err, data) instead of (data)
	// XXX: Fix exit code
	var item = this.search(fqdn)[0];
	if (!item) {
		callback(`Shredding failed: fqdn ${fqdn} not found`);
		return;
	}

	var dir   = item.path;
	var files = beameDirApi.getCertsFiles(dir);

	var del_functions = files.map(f => {
		return cb => fs.unlink(path.join(dir, f), cb);
	});

	async.parallel(del_functions, error => {
		this.ensureFreshBeameStore();
		if (error) {
			callback({"status": "error", "message": error});
		} else {
			callback({"status": "ok", "message": `${files.length} files deleted`});
		}
	})
};


module.exports = BeameStore;
