import './approve-prs-from-list.css';

import React from 'dom-chef';
import * as pageDetect from 'github-url-detection';
import CheckIcon from 'octicons-plain-react/Check';
import {$, $optional, closestElement, elementExists} from 'select-dom';

import features from '../feature-manager.js';
import api from '../github-helpers/api.js';
import {getLoggedInUser} from '../github-helpers/index.js';
import observe from '../helpers/selector-observer.js';

const confirmTimeout = 3000;
// Ignore accidental double-clicks
const minConfirmDelay = 400;

const prIdQuery = `
	query ($repoOwner: String!, $repoName: String!, $prNumber: Int!) {
		repository(owner: $repoOwner, name: $repoName) {
			pullRequest(number: $prNumber) {
				id
			}
		}
	}
`;

const approveMutation = `
	mutation ($pullRequestId: ID!) {
		addPullRequestReview(input: {pullRequestId: $pullRequestId, event: APPROVE}) {
			clientMutationId
		}
	}
`;

async function approve(url: URL): Promise<void> {
	const [, owner, name, , number] = url.pathname.split('/', 5);
	const {repository} = await api.v4uncached(prIdQuery, {
		variables: {repoOwner: owner, repoName: name, prNumber: Number(number)},
	});

	await api.v4uncached(approveMutation, {
		variables: {pullRequestId: repository.pullRequest.id},
	});
}

function getAuthor(row: HTMLElement): string | undefined {
	// React list
	const filterLink = $optional('a[data-testid="author-filter-link"]', row);
	if (filterLink) {
		return filterLink.getAttribute('aria-label')!.replace('Filter by author ', '');
	}

	// Classic list: The link always ends with the author
	const userLink = $optional('.opened-by a[data-hovercard-type="user"]', row);
	return userLink?.href.split('author%3A', 2)[1]; // Missing if the author is a ghost
}

function isReviewable(row: HTMLElement, metadataLine: HTMLElement): boolean {
	// Only open non-draft PRs have this exact icon
	if (!elementExists('svg.octicon-git-pull-request', row)) {
		return false;
	}

	// The author is undefined for ghost users
	if (getAuthor(row)?.toLowerCase() === getLoggedInUser()!.toLowerCase()) {
		return false;
	}

	// The line also contains the review state, if any (e.g. "Approved", "1 review approval")
	return !/\bapprov(?:ed|al)/i.test(metadataLine.textContent);
}

function addButton(titleLink: HTMLAnchorElement): void {
	const row = closestElement(['.js-issue-row', 'li'], titleLink);
	// The button only exists if the row was previously processed (React re-renders rows)
	$optional('.rgh-approve-pr', row)?.remove();

	// Both anchors are inside the "#123 opened by …" line
	const metadataLine = $(['.opened-by', '[data-testid="timestamp-container"]'], row).parentElement!;
	if (!isReviewable(row, metadataLine)) {
		return;
	}

	let confirmedAt: number | undefined;
	let resetTimeout: ReturnType<typeof setTimeout> | undefined;

	const button = (
		<button
			type="button"
			className="btn btn-sm rgh-approve-pr"
		>
			<CheckIcon className="color-fg-success" />
			{' Approve'}
		</button>
	) as unknown as HTMLButtonElement;

	function setState(label: string, className: string, title = ''): void {
		button.replaceChildren(<CheckIcon />, ` ${label}`);
		button.className = `btn btn-sm rgh-approve-pr ${className}`;
		button.title = title;
	}

	function reset(): void {
		clearTimeout(resetTimeout);
		confirmedAt = undefined;
		button.disabled = false;
		setState('Approve', '');
		button.firstElementChild!.classList.add('color-fg-success');
	}

	button.addEventListener('blur', () => {
		if (!button.disabled) {
			reset();
		}
	});

	button.addEventListener('click', async event => {
		event.preventDefault();
		event.stopPropagation();

		if (!confirmedAt) {
			confirmedAt = Date.now();
			setState('Confirm', 'btn-primary', 'Click again to approve');
			resetTimeout = setTimeout(reset, confirmTimeout);
			return;
		}

		if (Date.now() - confirmedAt < minConfirmDelay || button.disabled) {
			return;
		}

		clearTimeout(resetTimeout);
		button.disabled = true;
		setState('Approving…', '');

		try {
			await approve(new URL(titleLink.href));
			button.remove();
		} catch (error) {
			button.disabled = false;
			confirmedAt = undefined;
			setState('Failed, retry', 'btn-danger', error instanceof Error ? error.message : String(error));
			resetTimeout = setTimeout(reset, confirmTimeout * 2);
			throw error;
		}
	});

	metadataLine.append(button);
}

function init(signal: AbortSignal): void {
	observe(
		[
			'.js-issue-row a.js-navigation-open[data-hovercard-type="pull_request"]',
			'a[data-testid="listitem-title-link"][data-hovercard-type="pull_request"]',
		],
		addButton,
		{signal},
	);
}

void features.add(import.meta.url, {
	include: [
		pageDetect.isPRList,
	],
	requiresToken: true,
	init,
});

/*

Test URLs

- github.com: https://github.com/pulls
- Repo PR list: https://github.com/refined-github/sandbox/pulls
- GHE (classic list): https://gh.asml.com/asml-gh/semantic-version-release/pulls

*/
