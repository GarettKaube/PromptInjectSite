import { insertPodReservation, getCreatedAt, deletePodReservation, getNumSessionsByIP, updatePodReservation } from "./postgres";

await insertPodReservation({
    sessionId: "550e8400-e29b-41d4-a716-446655440000",
    ownerIpHash: "8349ghdsfj"
})

const result = await getCreatedAt({
    sessionId: "550e8400-e29b-41d4-a716-446655440000",
    ownerIpHash: "8349ghdsfj"
})

console.log(result.createdAt)


// await deletePodReservation(
//     {
//     sessionId: "550e8400-e29b-41d4-a716-446655440000",
//     ownerIpHash: "8349ghdsfj"
// }
// )

const yo = await getNumSessionsByIP(
    {
    sessionId: "550e8400-e29b-41d4-a716-446655440000",
    ownerIpHash: "8349ghdsfj"
}
)

const yo2 = await updatePodReservation({
    sessionId: "550e8400-e29b-41d4-a716-446655440000",
    ownerIpHash: "8349ghdsfj",
    podName: "yopod123",
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date()
})

console.log(yo2)


