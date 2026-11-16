import { diffChars } from "diff";

function getInsertions(original: string, modified: string) {
    const changes = diffChars(original, modified);

    let position = 0;
    const insertions = [];

    for (const change of changes) {
        if (change.added) {
            insertions.push({
                position,
                text: change.value
            });

            position += change.value.length;
        } else if (!change.removed) {
            position += change.value.length;
        }
    }

    return insertions;
}

