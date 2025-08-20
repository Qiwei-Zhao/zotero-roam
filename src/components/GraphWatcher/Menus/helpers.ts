import { SemanticScholarAPI } from "@clients/semantic";

import { identifyChildren, parseDOI } from "../../../utils";

import { AsBoolean } from "Types/helpers";
import { isSBacklink, RCitekeyPages, SCleanItem, SEnrichedItem, SEnrichedItemCitation, SEnrichedItemReference, SEnrichedItemTypeEnum, SRelatedEntries, ZItemTop, ZLibraryContents } from "Types/transforms";


/** Formats a list of Semantic Scholar entries for display */
function cleanSemantic(
	datastore: ZLibraryContents,
	semantic: Pick<SemanticScholarAPI.Item, "citations" | "references">,
	roamCitekeys: RCitekeyPages
): SRelatedEntries {
	const { items = [], pdfs = [], notes = [] } = datastore || {};
	const itemsWithDOIs = (Array.isArray(items) ? items : []).filter(it => parseDOI(it.data.DOI));
	// * Note: DOIs from the Semantic Scholar queries are sanitized at fetch
	const { citations = [], references = [] } = semantic || {};
	
	// Debug logging - Extension loaded check
	console.log('🚀 ZoteroRoam Debug: Extension loaded and semantic data processing started!', new Date().toISOString());
	console.log('ZoteroRoam Debug: Total items in library:', items.length);
	console.log('ZoteroRoam Debug: Items with valid DOIs:', itemsWithDOIs.length);
	console.log('ZoteroRoam Debug: Citations from Semantic Scholar:', citations.length);
	console.log('ZoteroRoam Debug: References from Semantic Scholar:', references.length);
	if (itemsWithDOIs.length > 0) {
		console.log('ZoteroRoam Debug: Sample library DOIs:', itemsWithDOIs.slice(0, 3).map(it => parseDOI(it.data.DOI)));
	}
	if (citations.length > 0) {
		console.log('ZoteroRoam Debug: Sample citation data:');
		citations.slice(0, 3).forEach(cit => {
			console.log(`  - Title: ${cit.title?.substring(0, 50)}...`);
			console.log(`  - DOI from doi field: ${cit.doi}`);
			console.log(`  - DOI from externalIds: ${cit.externalIds?.DOI || 'none'}`);
			console.log(`  - Final parsed DOI: ${parseDOI(cit.externalIds?.DOI || cit.doi)}`);
		});
	}

	const clean_citations: SEnrichedItemCitation[] = (Array.isArray(citations) ? citations : []).map((cit) => {
		const cleanProps = matchSemanticEntry(cit, { items: itemsWithDOIs, pdfs, notes }, roamCitekeys);
		return {
			...cleanProps,
			_type: SEnrichedItemTypeEnum.CITING
		};
	});

	const clean_references: SEnrichedItemReference[] = (Array.isArray(references) ? references : []).map((ref) => {
		const cleanProps = matchSemanticEntry(ref, { items: itemsWithDOIs, pdfs, notes }, roamCitekeys);
		return {
			...cleanProps,
			_type: SEnrichedItemTypeEnum.CITED
		};
	});

	return {
		citations: clean_citations,
		references: clean_references,
		backlinks: [...clean_references, ...clean_citations].filter(isSBacklink)
	};
}


/** Formats the metadata of a Semantic Scholar entry */
function cleanSemanticItem(item: SemanticScholarAPI.RelatedPaper): SCleanItem {
	// Extract DOI from externalIds first, then fall back to doi field
	const extractedDOI = item.externalIds?.DOI || item.doi || null;
	const parsedDOI = parseDOI(extractedDOI);
	
	console.log('ZoteroRoam Debug: cleanSemanticItem DOI extraction for', item.title?.substring(0, 30) + '...');
	console.log('  - Raw doi field:', item.doi);
	console.log('  - ExternalIds DOI:', item.externalIds?.DOI);
	console.log('  - Final parsed DOI:', parsedDOI);
	
	const clean_item: SCleanItem = {
		authors: "",
		authorsLastNames: [],
		authorsString: "",
		//* Note: SemanticScholar DOIs are sanitized on fetch
		doi: parsedDOI,
		intent: item.intent,
		isInfluential: item.isInfluential,
		links: {},
		meta: (item.venue || "").split(/ ?:/)[0], // If the publication has a colon, only take the portion that precedes it
		title: item.title,
		url: item.url || "",
		year: item.year ? item.year.toString() : "",
		_multiField: ""
	};

	// Parse authors data
	const authors = Array.isArray(item.authors) ? item.authors : [];
	clean_item.authorsLastNames = authors.map(a => getAuthorLastName(a?.name));
	clean_item.authorsString = clean_item.authorsLastNames.join(" ");
	clean_item.authors = makeAuthorsSummary(clean_item.authorsLastNames);

	// Parse external links
	if (item.paperId) {
		clean_item.links["semantic-scholar"] = `https://www.semanticscholar.org/paper/${item.paperId}`;
	}
	if (item.arxivId) {
		clean_item.links.arxiv = `https://arxiv.org/abs/${item.arxivId}`;
	}
	if (item.doi || item.title) {
		clean_item.links["connected-papers"] = "https://www.connectedpapers.com/" + (item.doi ? "api/redirect/doi/" + item.doi : "search?q=" + encodeURIComponent(item.title));
		clean_item.links["google-scholar"] = "https://scholar.google.com/scholar?q=" + (item.doi || encodeURIComponent(item.title));
	}

	// Set multifield property for search
	clean_item._multiField = [
		clean_item.authorsString,
		clean_item.year,
		clean_item.title
	].filter(AsBoolean).join(" ");

	return clean_item;
}


/** Compares two Zotero items by publication year then alphabetically, to determine sort order
 * @returns The comparison outcome
 */
function compareItemsByYear(a: ZItemTop, b: ZItemTop): (-1 | 1) {
	if (!a.meta.parsedDate) {
		if (!b.meta.parsedDate) {
			return a.meta.creatorSummary < b.meta.creatorSummary ? -1 : 1;
		} else {
			return 1;
		}
	} else {
		if (!b.meta.parsedDate) {
			return -1;
		} else {
			const date_diff = new Date(a.meta.parsedDate).getUTCFullYear() - new Date(b.meta.parsedDate).getUTCFullYear();
			if (date_diff < 0) {
				return -1;
			} else if (date_diff == 0) {
				return a.meta.creatorSummary < b.meta.creatorSummary ? -1 : 1;
			} else {
				return 1;
			}
		}
	}
}


/** Extracts an author's last name */
function getAuthorLastName(name: string): string {
	if (!name || typeof name !== 'string') return "";
	const components = name.replaceAll(".", " ").split(" ").filter(AsBoolean);
	if (components.length == 1) {
		return components[0];
	} else {
		return components.slice(1).filter(c => c.length > 1).join(" ");
	}
}


/** Formats authoring metadata */
function makeAuthorsSummary(names: string[]): string {
	switch (names.length) {
	case 0:
		return "";
	case 1:
		return names[0];
	case 2:
		return names[0] + " & " + names[1];
	case 3:
		return names[0] + ", " + names[1] + " & " + names[2];
	default:
		return names[0] + " et al.";
	}
}


/** Matches a clean Semantic Scholar entry to Zotero and Roam data */
function matchSemanticEntry(
	semanticItem: SemanticScholarAPI.RelatedPaper,
	datastore: Partial<ZLibraryContents>,
	roamCitekeys: RCitekeyPages
): SEnrichedItem {
	const { items = [], pdfs = [], notes = [] } = datastore;
	const cleanItem = cleanSemanticItem(semanticItem);
	
	let libItem: ZItemTop | undefined;
	
	// First try: Match by DOI
	if (cleanItem.doi) {
		console.log('ZoteroRoam Debug: Searching for DOI:', cleanItem.doi, 'in title:', cleanItem.title.substring(0, 50) + '...');
		libItem = items.find(it => {
			const libDOI = parseDOI(it.data.DOI);
			if (libDOI === cleanItem.doi) {
				console.log('ZoteroRoam Debug: EXACT DOI MATCH found!', 'Semantic DOI:', cleanItem.doi, 'Library DOI:', libDOI);
				return true;
			}
			return false;
		});
		
		// If no exact match, try more flexible DOI matching strategies
		if (!libItem && cleanItem.doi) {
			libItem = items.find(it => {
				if (!it.data || !it.data.DOI) return false;
				
				const libDOI = parseDOI(it.data.DOI);
				if (!libDOI) return false;
				
				// Try case-insensitive comparison
				if (libDOI.toLowerCase() === cleanItem.doi.toLowerCase()) {
					console.log('ZoteroRoam Debug: CASE-INSENSITIVE DOI MATCH found!', 'Semantic DOI:', cleanItem.doi, 'Library DOI:', libDOI);
					return true;
				}
				
				// Try removing common prefixes/suffixes and URLs
				const cleanSemanticDOI = cleanItem.doi
					.replace(/^(https?:\/\/)?(dx\.)?doi\.org\//, '')
					.replace(/^doi:/, '')
					.toLowerCase()
					.trim();
				const cleanLibDOI = libDOI
					.replace(/^(https?:\/\/)?(dx\.)?doi\.org\//, '')
					.replace(/^doi:/, '')
					.toLowerCase()
					.trim();
					
				if (cleanSemanticDOI === cleanLibDOI && cleanSemanticDOI.length > 5) {
					console.log('ZoteroRoam Debug: CLEANED DOI MATCH found!', 'Semantic DOI:', cleanSemanticDOI, 'Library DOI:', cleanLibDOI);
					return true;
				}
				
				// Try partial DOI matching for cases where one DOI might be truncated
				if (cleanSemanticDOI.length > 10 && cleanLibDOI.length > 10) {
					if (cleanSemanticDOI.includes(cleanLibDOI) || cleanLibDOI.includes(cleanSemanticDOI)) {
						console.log('ZoteroRoam Debug: PARTIAL DOI MATCH found!', 'Semantic DOI:', cleanSemanticDOI, 'Library DOI:', cleanLibDOI);
						return true;
					}
				}
				
				return false;
			});
		}
		
		console.log('ZoteroRoam Debug: DOI match for', cleanItem.title.substring(0, 50) + '...', '- Found:', !!libItem);
		if (!libItem) {
			console.log('ZoteroRoam Debug: Available library DOIs (first 5):', items.slice(0, 5).map(it => ({ title: it.data.title?.substring(0, 30), doi: parseDOI(it.data.DOI) })));
		}
	}
	
	// Only match by DOI for accuracy - no title matching
	if (!libItem && !cleanItem.doi) {
		console.log('ZoteroRoam Debug: No DOI available for', cleanItem.title.substring(0, 50) + '... - Cannot match without DOI');
	}
	
	if (!libItem) {
		return {
			...cleanItem,
			inGraph: false,
			inLibrary: false
		};
	} else {
		// Ensure libItem has all required properties
		if (!libItem.data || !libItem.library || !libItem.library.type || !libItem.library.id) {
			console.warn('ZoteroRoam Debug: Invalid libItem structure:', libItem);
			return {
				...cleanItem,
				inGraph: false,
				inLibrary: false
			};
		}
		
		const itemKey = libItem.data.key;
		const location = libItem.library.type + "s/" + libItem.library.id;
		const children = identifyChildren(itemKey, location, { pdfs: pdfs, notes: notes });

		return {
			...cleanItem,
			inGraph: roamCitekeys.get("@" + libItem.key) || false,
			inLibrary: {
				children,
				raw: libItem
			}
		};
	}
}


export { cleanSemantic, cleanSemanticItem, compareItemsByYear, getAuthorLastName, makeAuthorsSummary };