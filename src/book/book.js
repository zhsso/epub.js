import EventEmitter from "event-emitter";
import {extend, defer} from "../utils/core";
import Url from "../utils/url";
import Path from "../utils/path";
import Spine from "./spine";
import Locations from "./locations";
import Container from "./container";
import Packaging from "./packaging";
import Navigation from "./navigation";
import Resources from "./resources";
import PageList from "./pagelist";
import Archive from "./archive";
import request from "../utils/request";
import EpubCFI from "../utils/epubcfi";
import { EVENTS } from "../utils/constants";

const CONTAINER_PATH = "META-INF/container.xml";
const EPUBJS_VERSION = "0.4";

const INPUT_TYPE = {
	BINARY: "binary",
	BASE64: "base64",
	EPUB: "epub",
	OPF: "opf",
	MANIFEST: "json",
	DIRECTORY: "directory"
};

/**
 * An Epub representation with methods for the loading, parsing and manipulation
 * of its contents.
 * @class
 * @param {string} [url]
 * @param {object} [options]
 * @param {method} [options.requestMethod] a request function to use instead of the default
 * @param {boolean} [options.requestCredentials=undefined] send the xhr request withCredentials
 * @param {object} [options.requestHeaders=undefined] send the xhr request headers
 * @param {string} [options.encoding=binary] optional to pass 'binary' or base64' for archived Epubs
 * @param {string} [options.replacements=none] use base64, blobUrl, or none for replacing assets in archived Epubs
 * @param {method} [options.canonical] optional function to determine canonical urls for a path
 * @returns {Book}
 * @example new Book("/path/to/book.epub", {})
 * @example new Book({ replacements: "blobUrl" })
 */
class Book {
	constructor(url, options) {
		// Allow passing just options to the Book
		if (typeof(options) === "undefined"
			&& typeof(url) === "object") {
			options = url;
			url = undefined;
		}

		this.settings = extend(this.settings || {}, {
			requestMethod: undefined,
			requestCredentials: undefined,
			requestHeaders: undefined,
			encoding: undefined,
			replacements: undefined,
			canonical: undefined
		});

		extend(this.settings, options);


		// Promises
		this.opening = new defer();
		/**
		 * @member {promise} opened returns after the book is loaded
		 * @memberof Book
		 */
		this.opened = this.opening.promise;
		this.isOpen = false;

		this.loading = {
			manifest: new defer(),
			spine: new defer(),
			metadata: new defer(),
			cover: new defer(),
			navigation: new defer(),
			pageList: new defer(),
			resources: new defer()
		};

		this.loaded = {
			manifest: this.loading.manifest.promise,
			spine: this.loading.spine.promise,
			metadata: this.loading.metadata.promise,
			cover: this.loading.cover.promise,
			navigation: this.loading.navigation.promise,
			pageList: this.loading.pageList.promise,
			resources: this.loading.resources.promise
		};

		/**
		 * @member {promise} ready returns after the book is loaded and parsed
		 * @memberof Book
		 * @private
		 */
		this.ready = Promise.all([
			this.loaded.manifest,
			this.loaded.spine,
			this.loaded.metadata,
			this.loaded.cover,
			this.loaded.navigation,
			this.loaded.resources,
			this.opened
		]).then(() => {
			return this.toObject();
		});


		// Queue for methods used before opening
		this.isRendered = false;
		// this._q = queue(this);

		/**
		 * @member {method} request
		 * @memberof Book
		 * @private
		 */
		this.request = this.settings.requestMethod || request;

		/**
		 * @member {Spine} spine
		 * @memberof Book
		 */
		this.spine = new Spine();

		/**
		 * @member {Locations} locations
		 * @memberof Book
		 */
		this.locations = new Locations(this.spine, this.load.bind(this));

		/**
		 * @member {Navigation} navigation
		 * @memberof Book
		 */
		this.navigation = undefined;

		/**
		 * @member {PageList} pagelist
		 * @memberof Book
		 */
		this.pageList = undefined;

		/**
		 * @member {Url} url
		 * @memberof Book
		 * @private
		 */
		this.url = undefined;

		/**
		 * @member {Path} path
		 * @memberof Book
		 * @private
		 */
		this.path = undefined;

		/**
		 * @member {boolean} archived
		 * @memberof Book
		 * @private
		 */
		this.archived = false;

		/**
		 * @member {Archive} archive
		 * @memberof Book
		 * @private
		 */
		this.archive = undefined;

		/**
		 * @member {Resources} resources
		 * @memberof Book
		 * @private
		 */
		this.resources = undefined;


		/**
		 * @member {Container} container
		 * @memberof Book
		 * @private
		 */
		this.container = undefined;

		/**
		 * @member {Packaging} packaging
		 * @memberof Book
		 * @private
		 */
		this.packaging = undefined;

		// this.toc = undefined;

		if (this.settings.stylesheet) {
			this.spine.hooks.content.register(this.injectStylesheet.bind(this));
		}

		if (this.settings.script) {
			this.spine.hooks.content.register(this.injectScript.bind(this));
		}

		this.spine.hooks.content.register(this.injectIdentifier.bind(this));

		if(url) {
			this.open(url).catch((error) => {
				var err = new Error("Cannot load book at "+ url );
				this.emit(EVENTS.BOOK.OPEN_FAILED, err);
			});
		}
	}

	/**
	 * Open a epub or url
	 * @param {string | ArrayBuffer} input Url, Path or ArrayBuffer
	 * @param {string} [what="binary", "base64", "epub", "opf", "json", "directory"] force opening as a certain type
	 * @returns {Promise} of when the book has been loaded
	 * @example book.open("/path/to/book.epub")
	 */
	open(input, what) {
		var opening;
		var type = what || this.determineType(input);

		if (type === INPUT_TYPE.BINARY) {
			this.archived = true;
			this.url = new Url("/", "");
			opening = this.openEpub(input);
		} else if (type === INPUT_TYPE.BASE64) {
			this.archived = true;
			this.url = new Url("/", "");
			opening = this.openEpub(input, type);
		} else if (type === INPUT_TYPE.EPUB) {
			this.archived = true;
			this.url = new Url("/", "");
			opening = this.request(input, "binary")
				.then(this.openEpub.bind(this));
		} else if(type == INPUT_TYPE.OPF) {
			this.url = new Url(input);
			opening = this.openPackaging(this.url.Path.toString());
		} else if(type == INPUT_TYPE.MANIFEST) {
			this.url = new Url(input);
			opening = this.openManifest(this.url.Path.toString());
		} else {
			this.url = new Url(input);
			opening = this.openContainer(CONTAINER_PATH)
				.then(this.openPackaging.bind(this));
		}

		return opening;
	}

	/**
	 * Open an archived epub
	 * @private
	 * @param  {binary} data
	 * @param  {string} [encoding]
	 * @return {Promise}
	 */
	openEpub(data, encoding) {
		return this.unarchive(data, encoding || this.settings.encoding)
			.then(() => {
				return this.openContainer(CONTAINER_PATH);
			})
			.then((packagePath) => {
				return this.openPackaging(packagePath);
			});
	}

	/**
	 * Open the epub container
	 * @private
	 * @param  {string} url
	 * @return {string} packagePath
	 */
	openContainer(url) {
		return this.load(url)
			.then((xml) => {
				this.container = new Container(xml);
				return this.resolve(this.container.packagePath);
			});
	}

	/**
	 * Open the Open Packaging Format Xml
	 * @private
	 * @param  {string} url
	 * @return {Promise}
	 */
	openPackaging(url) {
		this.path = new Path(url);
		return this.load(url)
			.then((xml) => {
				this.packaging = new Packaging(xml);
				return this.unpack(this.packaging);
			});
	}

	/**
	 * Open the manifest JSON
	 * @private
	 * @param  {string} url
	 * @return {Promise}
	 */
	openManifest(url) {
		this.path = new Path(url);
		return this.load(url)
			.then((json) => {
				this.packaging = new Packaging();
				this.packaging.load(json);
				return this.unpack(this.packaging);
			});
	}

	/**
	 * Load a resource from the Book
	 * @param  {string} path path to the resource to load
	 * @return {Promise}     returns a promise with the requested resource
	 */
	load(path) {
		var resolved;

		if(this.archived) {
			resolved = this.resolve(path);
			return this.archive.request(resolved);
		} else {
			resolved = this.resolve(path);
			return this.request(resolved, null, this.settings.requestCredentials, this.settings.requestHeaders);
		}
	}

	/**
	 * Resolve a path to it's absolute position in the Book
	 * @param  {string} path
	 * @param  {boolean} [absolute] force resolving the full URL
	 * @return {string}          the resolved path string
	 */
	resolve(path, absolute) {
		if (!path) {
			return;
		}
		let resolved = path;
		let isAbsolute = (path.indexOf("://") > -1);

		if (isAbsolute) {
			return path;
		}

		if (this.path) {
			resolved = this.path.resolve(path);
		}

		if(absolute != false && this.url) {
			resolved = this.url.resolve(resolved);
		}

		return resolved;
	}

	/**
	 * Get a canonical link to a path
	 * @param  {string} path
	 * @return {string} the canonical path string
	 */
	canonical(path) {
		var url = path;

		if (!path) {
			return "";
		}

		if (this.settings.canonical) {
			url = this.settings.canonical(path);
		} else {
			url = this.resolve(path, true);
		}

		return url;
	}

	/**
	 * Determine the type of they input passed to open
	 * @private
	 * @param  {string} input
	 * @return {string}  binary | directory | epub | opf
	 */
	determineType(input) {
		var url;
		var path;
		var extension;

		if (this.settings.encoding === "base64") {
			return INPUT_TYPE.BASE64;
		}

		if(typeof(input) != "string") {
			return INPUT_TYPE.BINARY;
		}

		url = new Url(input);
		path = url.path();
		extension = path.extension;

		if (!extension) {
			return INPUT_TYPE.DIRECTORY;
		}

		if(extension === "epub"){
			return INPUT_TYPE.EPUB;
		}

		if(extension === "opf"){
			return INPUT_TYPE.OPF;
		}

		if(extension === "json"){
			return INPUT_TYPE.MANIFEST;
		}
	}


	/**
	 * unpack the contents of the Books packageXml
	 * @private
	 * @param {document} packageXml XML Document
	 */
	unpack(opf) {
		this.package = opf;

		this.spine.unpack(this.package, this.resolve.bind(this), this.canonical.bind(this));

		this.resources = new Resources(this.package.manifest, {
			archive: this.archive,
			resolver: this.resolve.bind(this),
			request: this.request.bind(this),
			replacements: this.settings.replacements || (this.archived ? "blobUrl" : "base64")
		});

		if (this.package.coverPath) {
			this.cover = this.resolve(this.package.coverPath);
		}
		// Resolve promises
		this.loading.metadata.resolve(this.package.metadata);
		this.loading.manifest.resolve(this.package.manifest);
		this.loading.spine.resolve(this.spine);
		this.loading.cover.resolve(this.cover);
		this.loading.resources.resolve(this.resources);
		this.loading.pageList.resolve(this.pageList);

		this.loadNavigation(this.package).then(() => {
			// this.toc = this.navigation.toc;
			this.loading.navigation.resolve(this.navigation);
		});

		this.isOpen = true;

		if(this.archived || this.settings.replacements && this.settings.replacements != "none") {
			this.replacements().then(() => {
				this.opening.resolve(this);
			}).catch((err) => {
				console.error(err);
			});
		} else {
			// Resolve book opened promise
			this.opening.resolve(this);
		}

	}

	/**
	 * Load Navigation and PageList from package
	 * @private
	 * @param {document} opf XML Document
	 */
	loadNavigation(opf) {
		let navPath = opf.navPath || opf.ncxPath;
		let toc = opf.toc;

		// From json manifest
		if (toc) {
			return new Promise((resolve, reject) => {
				this.navigation = new Navigation(toc);

				if (opf.pageList) {
					this.pageList = new PageList(opf.pageList); // TODO: handle page lists from Manifest
				}

				resolve(this.navigation);
			});
		}

		if (!navPath) {
			return new Promise((resolve, reject) => {
				this.navigation = new Navigation(null);
				this.pageList = new PageList();

				resolve(this.navigation);
			});
		}

		return this.load(navPath, "xml")
			.then((xml) => {
				this.navigation = new Navigation(xml, this.resolve(navPath), this.resolve.bind(this));
				this.pageList = new PageList(xml);
				return this.navigation;
			});
	}

	/**
	 * Gets a Section of the Book from the Spine
	 * Alias for `book.spine.get`
	 * @param {string} target
	 * @return {Section}
	 */
	section(target) {
		return this.spine.get(target, this.resolve.bind(this));
	}

	/**
	 * Set if request should use withCredentials
	 * @param {boolean} credentials
	 */
	setRequestCredentials(credentials) {
		this.settings.requestCredentials = credentials;
	}

	/**
	 * Set headers request should use
	 * @param {object} headers
	 */
	setRequestHeaders(headers) {
		this.settings.requestHeaders = headers;
	}

	/**
	 * Unarchive a zipped epub
	 * @private
	 * @param  {binary} input epub data
	 * @param  {string} [encoding]
	 * @return {Archive}
	 */
	unarchive(input, encoding) {
		this.archive = new Archive();
		return this.archive.open(input, encoding);
	}

	/**
	 * Get the cover url
	 * @return {string} coverUrl
	 */
	coverUrl() {
		var retrieved = this.loaded.cover.
			then((url) => {
				if(this.archived) {
					// return this.archive.createUrl(this.cover);
					return this.resources.get(this.cover);
				}else{
					return this.cover;
				}
			});

		return retrieved;
	}

	/**
	 * Load replacement urls
	 * @private
	 * @return {Promise} completed loading urls
	 */
	replacements() {
		this.spine.hooks.serialize.register((output, section) => {
			let url = this.resolve(section.source, true);
			section.output = this.resources.substitute(output, url);
		});

		return this.resources.replacements().
			then(() => {
				return this.resources.replaceCss();
			}).
			then(() => {
				let urls = [];
				this.spine.each((section) => {
					let urlPromise = section.createUrl(this.load.bind(this));
					urls.push(urlPromise);

					urlPromise.then((url) => {
						this.resources.replace(section.originalHref, url);
					});

				});
				return Promise.all(urls);
			})
	}

	/**
	 * Find a DOM Range for a given CFI Range
	 * @param  {EpubCFI} cfiRange a epub cfi range
	 * @return {Range}
	 */
	getRange(cfiRange) {
		var cfi = new EpubCFI(cfiRange);
		var item = this.spine.get(cfi.spinePos);
		var _request = this.load.bind(this);
		if (!item) {
			return new Promise((resolve, reject) => {
				reject("CFI could not be found");
			});
		}
		return item.load(_request).then(function (contents) {
			var range = cfi.toRange(item.document);
			return range;
		});
	}

	/**
	 * Generates the Book Key using the identifer in the manifest or other string provided
	 * @param  {string} [identifier] to use instead of metadata identifier
	 * @return {string} key
	 */
	key(identifier) {
		var ident = identifier || this.package.metadata.identifier || this.url.filename;
		return `epubjs:${EPUBJS_VERSION}:${ident}`;
	}

	/**
	 * Hook to handle injecting stylesheet before
	 * a Section is serialized
	 * @param  {document} doc
	 * @param  {Section} section
	 * @private
	 */
	injectStylesheet(doc, section) {
		let style = doc.createElement("link");
		style.setAttribute("type", "text/css");
		style.setAttribute("rel", "stylesheet");
		style.setAttribute("href", this.settings.stylesheet);
		doc.getElementsByTagName("head")[0].appendChild(style);
	}

	/**
	 * Hook to handle injecting scripts before
	 * a Section is serialized
	 * @param  {document} doc
	 * @param  {Section} section
	 * @private
	 */
	injectScript(doc, section) {
		let script = doc.createElement("script");
		script.setAttribute("type", "text/javascript");
		script.setAttribute("src", this.settings.script);
		script.textContent = " "; // Needed to prevent self closing tag
		doc.getElementsByTagName("head")[0].appendChild(script);
	}

	/**
	 * Hook to handle the document identifier before
	 * a Section is serialized
	 * @param  {document} doc
	 * @param  {Section} section
	 * @private
	 */
	injectIdentifier(doc, section) {
		const ident = this.package.metadata.identifier;

		let meta = doc.createElement("meta");
		meta.setAttribute("name", "dc.relation.ispartof");
		if (ident) {
			meta.setAttribute("content", ident);
		}
		doc.getElementsByTagName("head")[0].appendChild(meta);
	}

	/**
	 * Generates a object representation of the book structure
	 * @return {object}
	 */
	toObject() {
		let metadata = this.package.metadata;
		let spine = this.spine.toArray();
		let resources = this.resources.toArray();
		let toc = this.navigation.getTocArray(this.resources.resolve.bind(this.resources));
		let landmarks = this.navigation.getLandmarksArray(this.resources.resolve.bind(this.resources));
		let pageList = this.pageList.toArray();

		return {
			metadata,
			spine,
			resources,
			toc,
			landmarks,
			pageList
		 }
	 }

	/**
	 * Generates a JSON output of the book structure
	 */
	toJSON(key) {
		let obj = this.toObject();
		// Set the context
		obj["@context"] = "http://readium.org/webpub/default.jsonld";
		// Set metadata type
		obj.metadata["@type"] = "http://schema.org/Book";
		// Set url of this manifest
		let href = this.url ? this.url.directory + "manifest.json" : "manifest.json";
		obj.links = [
			{"rel": "self", "href": href, "type": "application/webpub+json"},
		]

		return JSON.stringify(obj);
	 }

	/**
	 * Destroy the Book and all associated objects
	 */
	destroy() {
		this.opened = undefined;
		this.loading = undefined;
		this.loaded = undefined;
		this.ready = undefined;

		this.isOpen = false;
		this.isRendered = false;

		this.spine && this.spine.destroy();
		this.locations && this.locations.destroy();
		this.pageList && this.pageList.destroy();
		this.archive && this.archive.destroy();
		this.resources && this.resources.destroy();
		this.container && this.container.destroy();
		this.packaging && this.packaging.destroy();

		this.spine = undefined;
		this.locations = undefined;
		this.pageList = undefined;
		this.archive = undefined;
		this.resources = undefined;
		this.container = undefined;
		this.packaging = undefined;

		this.navigation = undefined;
		this.url = undefined;
		this.path = undefined;
		this.archived = false;

	}

}

//-- Enable binding events to book
EventEmitter(Book.prototype);

export default Book;