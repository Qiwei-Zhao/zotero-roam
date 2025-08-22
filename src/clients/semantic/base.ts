import axios from "axios";
import axiosRetry from "axios-retry";

import { Queries } from "@services/react-query";

import { SemanticScholarAPI } from "./types";

import { cleanError, transformDOIs } from "../../utils";


const semanticClient = axios.create({
	baseURL: "https://api.semanticscholar.org/graph/v1/paper/",
	params: {
		"fields": "paperId,doi,referenceCount,citationCount,citations.title,citations.authors,citations.year,citations.externalIds,citations.venue,citations.paperId,citations.url,citations.doi,references.title,references.authors,references.year,references.externalIds,references.venue,references.paperId,references.url,references.doi",
		"citations.limit": 1000,
		"references.limit": 1000
	}
});
axiosRetry(semanticClient, {
	retries: 3
});


/** Fetch externalIds (specifically DOI) by paperId when missing on a related paper */
async function fetchExternalIdsByPaperId(paperId: string) {
	try {
		const { data } = await semanticClient.get<SemanticScholarAPI.BasePaper>(`${paperId}`, {
			params: { fields: "externalIds,paperId" }
		});
		return { externalIds: data.externalIds, paperId: data.paperId };
	} catch {
		return null;
	}
}

/** For citations/references, backfill missing externalIds.DOI via paperId */
async function augmentDOIs<T extends { paperId?: string, externalIds?: { DOI?: string }, doi: string | false | null }>(arr?: T[]): Promise<T[]> {
	const list = Array.isArray(arr) ? arr as T[] : [] as T[];
	const augmented = await Promise.all(list.map(async (p): Promise<T> => {
		const hasDOI = p.externalIds?.DOI;
		if (hasDOI || !p.paperId) return p;
		const fetched = await fetchExternalIdsByPaperId(p.paperId);
		if (fetched && fetched.externalIds?.DOI) {
			return { ...p, externalIds: { ...p.externalIds, ...fetched.externalIds } } as T;
		}
		return p;
	}));
	return augmented;
}


/** Requests data from the `/paper` endpoint of the Semantic Scholar API
 * @param doi - The DOI of the targeted item, assumed to have already been checked and parsed.
 * @returns Citation data for the item
**/
async function fetchSemantic(doi: string): Promise<Queries.Data.Semantic> {
	let response: unknown;

	try {
		const apiResponse = await semanticClient.get<SemanticScholarAPI.Item>(`DOI:${doi}`);
		const { data: { citations, references } } = apiResponse;
		response = apiResponse;

		// Backfill DOIs for entries missing externalIds.DOI using paperId lookup
		const [citationsWithDOI, referencesWithDOI] = await Promise.all([
			augmentDOIs(citations),
			augmentDOIs(references)
		]);

		return {
			doi,
			citations: transformDOIs(citationsWithDOI),
			references: transformDOIs(referencesWithDOI)
		};
	} catch (error) /* istanbul ignore next */ {
		window.zoteroRoam?.error?.({
			origin: "API",
			message: "Failed to fetch data from SemanticScholar",
			context: {
				error: cleanError(error),
				response
			}
		});
		return Promise.reject(error);
	}
}


export { fetchSemantic };